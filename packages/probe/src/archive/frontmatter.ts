// Restricted YAML-subset frontmatter reader for vault capture files (R5.2). Zero dependencies by
// design (the probe is bundled into exes); nothing here is copied from another project.
//
// Supported: a `---` delimited block at file start (UTF-8 BOM and CRLF tolerated), plain, single-
// and double-quoted scalars, numbers, booleans, null, block lists, flow lists, block maps, flow
// maps, lists of single-key maps, block scalars (| and >), comments. Timestamps stay strings.
// Unsupported (anchors, aliases, tags, multi-line quoted or flow values) -> the file is reported
// as skipped with a reason, never a throw. Input is hostile: nesting is capped and every scan is
// linear in the input.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };
export type YamlMap = { [k: string]: YamlValue };

export type FrontmatterResult =
  | { kind: "ok"; data: YamlMap; body: string }
  | {
      kind: "skip";
      reason:
        | "no_frontmatter"
        | "unterminated_frontmatter"
        | "unsupported_yaml"
        | "malformed_yaml"
        | "frontmatter_not_map";
    };

export const MAX_NESTING = 24;
export const MAX_FRONTMATTER_LINES = 5000;

class YamlError extends Error {
  readonly reason: "unsupported_yaml" | "malformed_yaml";
  constructor(reason: "unsupported_yaml" | "malformed_yaml") {
    super(reason);
    this.reason = reason;
  }
}
const bad = (): never => {
  throw new YamlError("malformed_yaml");
};
const unsupported = (): never => {
  throw new YamlError("unsupported_yaml");
};

interface Line {
  indent: number;
  text: string; // content after the indent, comment-only and blank lines excluded for block parsing
  raw: string;
}

function newMap(): YamlMap {
  return Object.create(null) as YamlMap;
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function plainScalar(s: string): YamlValue {
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "/": "/",
  " ": " ",
  e: "\x1b",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
};

/** Parses a quoted scalar starting at s[i] (the quote). Returns the value and the index after it. */
function quoted(s: string, i: number): [string, number] {
  const q = s[i];
  let out = "";
  let j = i + 1;
  if (q === "'") {
    for (;;) {
      const k = s.indexOf("'", j);
      if (k < 0) return bad();
      out += s.slice(j, k);
      if (s[k + 1] === "'") {
        out += "'";
        j = k + 2;
      } else return [out, k + 1];
    }
  }
  while (j < s.length) {
    const c = s[j] as string;
    if (c === '"') return [out, j + 1];
    if (c === "\\") {
      const e = s[j + 1];
      if (e === undefined) return bad();
      if (e === "x" || e === "u" || e === "U") {
        const len = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = s.slice(j + 2, j + 2 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return bad();
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) return bad();
        out += String.fromCodePoint(cp);
        j += 2 + len;
      } else {
        const r = ESCAPES[e];
        if (r === undefined) return bad();
        out += r;
        j += 2;
      }
    } else {
      out += c;
      j += 1;
    }
  }
  return bad(); // unterminated (multi-line quoted scalars are not supported)
}

function stripComment(s: string): string {
  // A comment starts at '#' at the start or after whitespace.
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i);
    }
  }
  return s;
}

function checkIndicator(s: string): void {
  const c = s[0];
  if (c === "&" || c === "*" || c === "!") unsupported();
  if (c === "@" || c === "`") bad();
}

/** Flow collection parser; one line only. */
class Flow {
  i: number;
  readonly s: string;
  constructor(s: string, start: number) {
    this.s = s;
    this.i = start;
  }
  ws(): void {
    while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i++;
  }
  value(depth: number): YamlValue {
    if (depth > MAX_NESTING) return bad();
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) return bad();
    if (c === "[") return this.list(depth);
    if (c === "{") return this.map(depth);
    if (c === '"' || c === "'") {
      const [v, j] = quoted(this.s, this.i);
      this.i = j;
      return v;
    }
    checkIndicator(this.s.slice(this.i, this.i + 1));
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i] as string;
      if (ch === "," || ch === "]" || ch === "}") break;
      if (ch === ":" && (this.s[this.i + 1] === " " || this.s[this.i + 1] === undefined)) break;
      if (ch === "[" || ch === "{") return bad();
      this.i++;
    }
    return plainScalar(this.s.slice(start, this.i).trim());
  }
  list(depth: number): YamlValue[] {
    this.i++; // [
    const out: YamlValue[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.s[this.i];
      if (c === ",") this.i++;
      else if (c !== "]") return bad();
    }
  }
  map(depth: number): YamlMap {
    this.i++; // {
    const out = newMap();
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const k = this.value(depth + 1);
      if (typeof k === "object" && k !== null) return bad();
      this.ws();
      let v: YamlValue = null;
      if (this.s[this.i] === ":") {
        this.i++;
        this.ws();
        const c = this.s[this.i];
        v = c === "," || c === "}" ? null : this.value(depth + 1);
      }
      out[String(k)] = v;
      this.ws();
      const c = this.s[this.i];
      if (c === ",") this.i++;
      else if (c !== "}") return bad();
    }
  }
}

/** A value on one line: quoted, flow or plain, with a trailing comment allowed. */
function inlineValue(text: string): YamlValue {
  const t = text.trim();
  if (t === "") return null;
  const c = t[0] as string;
  if (c === '"' || c === "'") {
    const [v, j] = quoted(t, 0);
    const rest = t.slice(j);
    if (rest.trim() !== "" && !/^\s+#/.test(rest)) return bad();
    return v;
  }
  if (c === "[" || c === "{") {
    const f = new Flow(t, 0);
    const v = f.value(0);
    const rest = t.slice(f.i).trim();
    if (rest !== "" && !/^#/.test(rest)) return bad();
    return v;
  }
  checkIndicator(t);
  return plainScalar(stripComment(t).trim());
}

/** Splits `key: rest` (key plain or quoted); null when the text is not a map entry. */
function splitKey(text: string): { key: string; rest: string } | null {
  const c = text[0];
  if (c === undefined || c === "[" || c === "{" || c === "#") return null;
  if (c === '"' || c === "'") {
    let k: string;
    let j: number;
    try {
      [k, j] = quoted(text, 0);
    } catch {
      return null;
    }
    while (text[j] === " " || text[j] === "\t") j++;
    if (text[j] !== ":") return null;
    if (text[j + 1] !== undefined && text[j + 1] !== " " && text[j + 1] !== "\t") return null;
    return { key: k, rest: text.slice(j + 1) };
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "#" && i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) return null;
    if (ch === ":" && (i + 1 === text.length || text[i + 1] === " " || text[i + 1] === "\t")) {
      const key = text.slice(0, i).trim();
      if (key === "") return null;
      checkIndicator(key);
      return { key, rest: text.slice(i + 1) };
    }
  }
  return null;
}

class BlockParser {
  i = 0;
  readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  // Block scalar lines are taken from `raw` of consecutive lines, so comment/blank filtering is
  // not applied to them: `lines` keeps every line, with `text === ""` for blank/comment-only.
  private skipBlank(): void {
    while (this.i < this.lines.length && (this.lines[this.i] as Line).text === "") this.i++;
  }

  parseTop(): YamlMap {
    this.skipBlank();
    if (this.i >= this.lines.length) return newMap();
    const first = this.lines[this.i] as Line;
    if (first.text.startsWith("- ") || first.text === "-") throw new NotMap();
    if (splitKey(first.text) === null) throw new NotMap();
    const m = this.map(first.indent, 0);
    this.skipBlank();
    if (this.i < this.lines.length) return bad();
    return m;
  }

  /** Block map at exactly `indent`. */
  map(indent: number, depth: number): YamlMap {
    if (depth > MAX_NESTING) return bad();
    const out = newMap();
    for (;;) {
      this.skipBlank();
      if (this.i >= this.lines.length) return out;
      const ln = this.lines[this.i] as Line;
      if (ln.indent < indent) return out;
      if (ln.indent > indent) return bad();
      if (ln.text.startsWith("- ") || ln.text === "-") return out; // belongs to a parent list
      const kv = splitKey(ln.text);
      if (!kv) return bad();
      this.i++;
      out[kv.key] = this.valueAfterKey(kv.rest, indent, depth);
    }
  }

  private valueAfterKey(rest: string, indent: number, depth: number): YamlValue {
    const r = rest.trim();
    if (r !== "" && !r.startsWith("#")) {
      if (/^[|>][-+0-9]*(\s+#.*)?$/.test(r)) return this.blockScalar(indent, r[0] === ">", r);
      return inlineValue(r);
    }
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    const nx = this.lines[this.i] as Line;
    if (nx.indent > indent) return this.node(nx.indent, depth + 1);
    if (nx.indent === indent && (nx.text.startsWith("- ") || nx.text === "-")) {
      return this.list(indent, depth + 1);
    }
    return null;
  }

  private node(indent: number, depth: number): YamlValue {
    if (depth > MAX_NESTING) return bad();
    const ln = this.lines[this.i] as Line;
    if (ln.text.startsWith("- ") || ln.text === "-") return this.list(indent, depth);
    if (splitKey(ln.text)) return this.map(indent, depth);
    // A multi-line plain scalar is not supported.
    return bad();
  }

  /** Block list whose dashes are at exactly `indent`. */
  list(indent: number, depth: number): YamlValue[] {
    if (depth > MAX_NESTING) return bad();
    const out: YamlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.i >= this.lines.length) return out;
      const ln = this.lines[this.i] as Line;
      if (ln.indent < indent) return out;
      if (ln.indent > indent) return bad();
      if (!(ln.text.startsWith("- ") || ln.text === "-")) return out;
      const after = ln.text === "-" ? "" : ln.text.slice(2);
      const lead = after.length - after.trimStart().length;
      const content = after.trimStart();
      if (content === "" || content.startsWith("#")) {
        this.i++;
        this.skipBlank();
        const nx = this.lines[this.i];
        if (nx && nx.indent > indent) out.push(this.node(nx.indent, depth + 1));
        else out.push(null);
        continue;
      }
      const contentIndent = indent + 2 + lead;
      const isNested = content.startsWith("- ") || content === "-" || splitKey(content) !== null;
      if (isNested) {
        // Re-seat the line as if the item's content started on its own line.
        this.lines[this.i] = { indent: contentIndent, text: content, raw: ln.raw };
        out.push(this.node(contentIndent, depth + 1));
      } else {
        this.i++;
        if (/^[|>][-+0-9]*(\s+#.*)?$/.test(content)) {
          out.push(this.blockScalar(indent, content[0] === ">", content));
        } else out.push(inlineValue(content));
      }
    }
  }

  /** Reads the lines indented deeper than `parentIndent` as a literal or folded scalar. */
  private blockScalar(parentIndent: number, folded: boolean, header: string): string {
    const chunk: string[] = [];
    let blockIndent = -1;
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i] as Line;
      const blank = ln.raw.trim() === "";
      if (!blank) {
        const ind = ln.raw.length - ln.raw.trimStart().length;
        if (ind <= parentIndent) break;
        if (blockIndent < 0) blockIndent = ind;
        if (ind < blockIndent) break;
      }
      chunk.push(blank ? "" : ln.raw.slice(blockIndent < 0 ? 0 : blockIndent));
      this.i++;
    }
    while (chunk.length > 0 && chunk[chunk.length - 1] === "") chunk.pop();
    const body = folded ? foldLines(chunk) : chunk.join("\n");
    return header.includes("-") ? body : chunk.length > 0 ? `${body}\n` : "";
  }
}

class NotMap extends Error {}

function foldLines(chunk: string[]): string {
  let out = "";
  for (let k = 0; k < chunk.length; k++) {
    const l = chunk[k] as string;
    if (k === 0) out = l;
    else if (l === "") out += "\n";
    else out += chunk[k - 1] === "" ? l : ` ${l}`;
  }
  return out;
}

/**
 * Splits a capture file into its frontmatter map and body. CRLF is normalized to LF first and a
 * UTF-8 BOM is dropped. Never throws.
 */
export function parseFrontmatter(input: string): FrontmatterResult {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes("\r")) text = text.replace(/\r\n/g, "\n");
  const nl = text.indexOf("\n");
  if (!/^---[ \t]*$/.test(nl < 0 ? text : text.slice(0, nl))) {
    return { kind: "skip", reason: "no_frontmatter" };
  }
  const all = text.split("\n");
  let close = -1;
  for (let k = 1; k < all.length && k <= MAX_FRONTMATTER_LINES + 1; k++) {
    const l = all[k] as string;
    if (/^(?:---|\.\.\.)[ \t]*$/.test(l)) {
      close = k;
      break;
    }
  }
  if (close < 0) return { kind: "skip", reason: "unterminated_frontmatter" };
  const lines: Line[] = [];
  for (let k = 1; k < close; k++) {
    const raw = all[k] as string;
    // Tabs as indentation are invalid YAML.
    if (/^ *\t/.test(raw) && raw.trim() !== "") return { kind: "skip", reason: "malformed_yaml" };
    const trimmed = raw.trimStart();
    const comment = trimmed === "" || trimmed.startsWith("#");
    lines.push({
      indent: raw.length - trimmed.length,
      text: comment ? "" : trimmed.trimEnd(),
      raw,
    });
  }
  const body = all.slice(close + 1).join("\n");
  try {
    const data = new BlockParser(lines).parseTop();
    return { kind: "ok", data, body };
  } catch (e) {
    if (e instanceof NotMap) return { kind: "skip", reason: "frontmatter_not_map" };
    if (e instanceof YamlError) return { kind: "skip", reason: e.reason };
    return { kind: "skip", reason: "malformed_yaml" };
  }
}
