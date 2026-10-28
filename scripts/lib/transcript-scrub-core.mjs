// Default-deny scrub of one transcript row (R0.7, transcript extension). Pure apart from the
// tables on the instance (placeholder numbering by first use) and the counters it fills.
//
// Every string is classified by its key path (see transcript-scrub-rules.mjs); unclassified strings
// outside the free-text zones become "<TEXT n>". Key names are default deny too: a name that is not
// in TRANSCRIPT_KEYS becomes "<KEY_n>" and is reported in unknownKeys so a person reviews it.
import { BUILTIN_AGENTS, BUILTIN_TOOLS } from "./fixture-allowlist.mjs";
import { TRANSCRIPT_KEYS } from "./fixture-keys.mjs";
import { isStructuralHookName } from "./transcript-scrub-hookname.mjs";
import { Mapper } from "./fixture-scrub-paths.mjs";
import {
  DROP_KEYS,
  FREE_ROOTS,
  LEAF,
  ENUM_RE,
  MODEL_KEYED,
  SPECIAL,
  USER_KEYED,
} from "./transcript-scrub-rules.mjs";
import { calledOutside, cutResult, isCalled, isResult } from "./transcript-scrub-cuts.mjs";
import {
  attachmentDropKeys,
  dropsRendered,
  hasContent,
  isOutsideProject,
  isPrivateSpelling,
  isPrivateToolUse,
  PRIVATE_CONTENT_KEYS,
  siblingPath,
} from "./transcript-scrub-private.mjs";
import { TextScrubber } from "./transcript-scrub-text.mjs";

const SAFE_KEY = /^-?[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
const MODEL_KEY = /^claude-[a-z0-9.-]{1,40}$/;
const TOKEN_SHAPE =
  /^(?:sk[-_]|ghp_|gho_|ghs_|ghu_|github_pat_|AKIA|ASIA|xox[a-z]-|Bearer\s)|[A-Fa-f0-9]{32,}/;
/** Path segment standing for a key name that is not in TRANSCRIPT_KEYS. */
const UNKNOWN_SEGMENT = "<unknown>";
export const THINKING_PLACEHOLDER = "<REDACTED-THINKING>";

const text = (/** @type {number} */ n) => `<TEXT ${n}>`;
const CALL_HEAD = /Called the \w+ tool with|Result of calling the \w+ tool/;

/** Key holding the text of a text block or a rendered[] entry, or undefined. @param {unknown} el */
function textKeyOf(el) {
  if (el === null || typeof el !== "object") return undefined;
  const o = /** @type {Record<string, unknown>} */ (el);
  if (typeof o.text === "string") return "text";
  return typeof o.content === "string" ? "content" : undefined;
}

export class TranscriptScrubber {
  /** @param {{ mapper?: Mapper, literals?: import("./transcript-scrub-text.mjs").Literals }} [opts] */
  constructor({ mapper = new Mapper(), literals = {} } = {}) {
    this.mapper = mapper;
    this.text = new TextScrubber(mapper, literals);
    /** @type {Map<string, number>} dropped key name -> count of subtrees replaced by a BLOB */
    this.dropped = new Map();
    /** @type {Map<string, number>} key path -> count of strings replaced by a TEXT placeholder */
    this.denied = new Map();
    /** @type {Map<string, number>} key path (unknown key as <KEY_n>) -> count */
    this.unknownKeys = new Map();
    /** @type {Map<string, string>} */
    this.names = new Map();
    /** tool_use ids whose tool touched something outside this project (their output is dropped) */
    this.privateToolIds = new Set();
    /** whether the row being scrubbed answers one of those tool uses */
    this.rowPrivate = false;
  }

  /**
   * Registers the tool uses of a whole fixture before any row is scrubbed, so a result is dropped
   * even when its tool_use is in another file of the same fixture.
   * @param {Iterable<unknown>} rows
   */
  prime(rows) {
    /** @param {unknown} v */
    const walk = (v) => {
      if (Array.isArray(v)) {
        for (const el of v) walk(el);
      } else if (v !== null && typeof v === "object") {
        const o = /** @type {Record<string, unknown>} */ (v);
        if (o.type === "tool_use" && typeof o.id === "string" && typeof o.name === "string") {
          if (isPrivateToolUse(o.name, this.#scrubbedInput(o.input))) this.privateToolIds.add(o.id);
        }
        for (const c of Object.values(o)) walk(c);
      }
    };
    for (const r of rows) walk(r);
  }

  /** Tool input with the strings the privacy rules read mapped to placeholders. @param {unknown} input */
  #scrubbedInput(input) {
    if (input === null || typeof input !== "object") return input;
    const inp = /** @type {Record<string, unknown>} */ (input);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of ["file_path", "path", "notebook_path"]) {
      const v = inp[k];
      if (typeof v === "string")
        out[k] =
          v.startsWith("~") || isPrivateSpelling(v) ? v : (this.mapper.mapPath(v, "auto") ?? v);
    }
    if (typeof inp.command === "string") out.command = this.text.scrub(inp.command);
    return out;
  }

  /** Whether a raw path points outside this project. @param {string} raw */
  #isOutsideRaw(raw) {
    if (raw.startsWith("~") || isPrivateSpelling(raw)) return true;
    const mapped = this.mapper.mapPath(raw, "auto");
    return mapped !== null && isOutsideProject(mapped);
  }

  /** Whether the object's own path field points outside this project. @param {Record<string, unknown>} obj */
  #outsideSibling(obj) {
    const raw = siblingPath(obj);
    return raw !== undefined && this.#isOutsideRaw(raw);
  }

  /** Scrubs one parsed row (or meta object). @param {unknown} row @returns {unknown} */
  row(row) {
    this.rowPrivate = this.#answersPrivateUse(row);
    return this.value(row, "");
  }

  /** @param {unknown} row */
  #answersPrivateUse(row) {
    const content = /** @type {any} */ (row)?.message?.content;
    if (!Array.isArray(content) || this.privateToolIds.size === 0) return false;
    return content.some(
      (b) => b?.type === "tool_result" && this.privateToolIds.has(String(b.tool_use_id)),
    );
  }

  /** @param {unknown} value @param {string} path @returns {unknown} */
  value(value, path) {
    if (typeof value === "string") return this.#string(value, path);
    if (Array.isArray(value)) return this.#array(value, path);
    if (value !== null && typeof value === "object") {
      return this.#object(/** @type {Record<string, unknown>} */ (value), path);
    }
    return value; // numbers, booleans and null carry structure only
  }

  /**
   * Scrubs the elements of an array. Text blocks come in pairs: "Called the X tool with the
   * following input: {...}" and then "Result of calling the X tool: ...". When the call named a
   * private path or command, the result block is cut down to its label.
   * @param {unknown[]} arr @param {string} path
   */
  #array(arr, path) {
    let pending = false;
    return arr.map((el) => {
      const out = this.value(el, `${path}[]`);
      const key = textKeyOf(el);
      if (key === undefined) return out;
      const raw = /** @type {string} */ (/** @type {any} */ (el)[key]);
      if (!CALL_HEAD.test(raw.slice(0, 200))) return out;
      const full = this.text.scrub(raw);
      if (isCalled(full)) {
        pending = calledOutside(full);
      } else if (pending && isResult(full)) {
        pending = false;
        const o = /** @type {Record<string, unknown>} */ (out);
        return { ...o, [key]: cutResult(String(o[key]), raw.length) };
      }
      return out;
    });
  }

  /** @param {string} v @param {string} path */
  #deny(v, path) {
    this.denied.set(path, (this.denied.get(path) ?? 0) + 1);
    return text(v.length);
  }

  /** @param {string} v */
  #named(v) {
    let ph = this.names.get(v);
    if (ph === undefined) {
      ph = `<NAME_${this.names.size + 1}>`;
      this.names.set(v, ph);
    }
    return ph;
  }

  /** @param {string} v @param {string} path */
  #string(v, path) {
    if (v === "") return v;
    const leaf = path.slice(path.lastIndexOf(".") + 1);
    const special = SPECIAL.find(([re]) => re.test(path));
    const rule = special ? special[1] : Object.hasOwn(LEAF, leaf) ? LEAF[leaf] : undefined;
    if (rule !== undefined) return this.#byRule(rule, v, path);
    const root = path.split(/[.[]/)[0] ?? "";
    // A value under a key nobody reviewed is never free text.
    if (path.includes(UNKNOWN_SEGMENT)) return this.#deny(v, path);
    return FREE_ROOTS.has(root) ? this.text.free(v) : this.#deny(v, path);
  }

  /** @param {import("./transcript-scrub-rules.mjs").Rule} rule @param {string} v @param {string} path */
  #byRule(rule, v, path) {
    switch (rule.kind) {
      case "pattern":
        return rule.re?.test(v) === true && !TOKEN_SHAPE.test(v) && !this.text.hasDenyWord(v)
          ? v
          : this.#deny(v, path);
      case "const":
        return rule.value ?? "";
      case "prRepository":
        return "<ACCOUNT>/<REPO>";
      case "prUrl": {
        const n = /\/pull\/(\d{1,7})(?!\d)/.exec(v)?.[1];
        return n ? `https://github.com/<ACCOUNT>/<REPO>/pull/${n}` : this.#deny(v, path);
      }
      case "agent":
        return this.mapper.mapAgent(v, BUILTIN_AGENTS);
      case "querySource":
        return this.#querySource(v, path);
      case "name":
        return this.#named(v);
      case "hookName":
        return isStructuralHookName(v) ? v : this.#named(v);
      case "tool":
        return this.mapper.mapTool(v, BUILTIN_TOOLS);
      case "mcp":
        return this.mapper.mapMcp(v);
      case "path":
        return this.mapper.mapPath(v, rule.path ?? "auto") ?? this.#deny(v, path);
      default:
        return this.#deny(v, path);
    }
  }

  /** Fixed words stay; agent:<kind>:<name> keeps the kind and numbers a custom name. @param {string} v @param {string} path */
  #querySource(v, path) {
    const m = /^(agent:[a-z]+:)(.+)$/.exec(v);
    if (m) return `${m[1]}${this.mapper.mapAgent(m[2] ?? "", BUILTIN_AGENTS)}`;
    return ENUM_RE.test(v) && !TOKEN_SHAPE.test(v) && !this.text.hasDenyWord(v)
      ? v
      : this.#deny(v, path);
  }

  /** @param {string} key @param {unknown} v @param {string} path */
  #drops(key, v, path) {
    if (!Object.hasOwn(DROP_KEYS, key) || (key === "shape" && path !== "")) return false;
    return v !== null && typeof v !== "number" && typeof v !== "boolean" && v !== "";
  }

  /** @param {Record<string, unknown>} obj @param {string} path */
  #object(obj, path) {
    const last = path.slice(path.lastIndexOf(".") + 1).replace(/\[\]$/, "");
    const userKeyed = USER_KEYED.has(last);
    const modelKeyed = MODEL_KEYED.has(last);
    const type = obj.type;
    const attachmentDrops = path === "attachment" ? attachmentDropKeys(obj) : null;
    const privateSibling = this.#outsideSibling(obj);
    const dropRendered = path === "" && dropsRendered(obj.attachment, (p) => this.#isOutsideRaw(p));
    /** @type {Record<string, unknown>} */
    const out = {};
    const used = new Set();
    let unknown = 0;
    for (const key of Object.keys(obj)) {
      let outKey = key;
      let seg = key;
      if (modelKeyed && MODEL_KEY.test(key)) {
        seg = "<key>";
      } else if (userKeyed || modelKeyed || key === "__proto__" || !SAFE_KEY.test(key)) {
        outKey = text(key.length);
        for (let n = 2; used.has(outKey); n += 1) outKey = `${text(key.length)}#${n}`;
        seg = "<key>";
      } else if (!TRANSCRIPT_KEYS.has(key)) {
        unknown += 1;
        outKey = `<KEY_${unknown}>`;
        seg = UNKNOWN_SEGMENT;
        const at = `${path === "" ? "" : `${path}.`}${outKey}`;
        this.unknownKeys.set(at, (this.unknownKeys.get(at) ?? 0) + 1);
      }
      used.add(outKey);
      const child = obj[key];
      const childPath = path === "" ? seg : `${path}.${seg}`;
      if (this.#forcedBlob(key, child, obj, path, privateSibling, attachmentDrops, dropRendered)) {
        out[outKey] = `<BLOB ${JSON.stringify(child).length}>`;
        this.dropped.set(`private:${key}`, (this.dropped.get(`private:${key}`) ?? 0) + 1);
        continue;
      }
      out[outKey] = this.#child(key, child, childPath, path, type);
    }
    return out;
  }

  /**
   * Private-content rules (transcript-scrub-private.mjs): contents next to a path outside this
   * project, output of a tool use that touched one, hook output and skill listings.
   * @param {string} key @param {unknown} v @param {Record<string, unknown>} obj @param {string} path
   * @param {boolean} privateSibling @param {ReadonlySet<string> | null} attachmentDrops
   * @param {boolean} dropRendered the row's rendered[] copy repeats private attachment content
   */
  #forcedBlob(key, v, obj, path, privateSibling, attachmentDrops, dropRendered) {
    if (!hasContent(v)) return false;
    if (dropRendered && key === "rendered") return true;
    if (privateSibling && PRIVATE_CONTENT_KEYS.has(key)) return true;
    if (attachmentDrops?.has(key)) return true;
    if (this.rowPrivate && path === "" && key === "toolUseResult") return true;
    return (
      key === "content" &&
      obj.type === "tool_result" &&
      this.privateToolIds.has(String(obj.tool_use_id))
    );
  }

  /** @param {string} key @param {unknown} v @param {string} childPath @param {string} path @param {unknown} type */
  #child(key, v, childPath, path, type) {
    if (this.#drops(key, v, path)) {
      this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
      return `<BLOB ${JSON.stringify(v).length}>`;
    }
    if (typeof v === "string") {
      if (key === "signature") return THINKING_PLACEHOLDER;
      if (type === "thinking" && key === "thinking") return THINKING_PLACEHOLDER;
      if (type === "redacted_thinking" && key === "data") return THINKING_PLACEHOLDER;
      if (type === "base64" && key === "data" && v !== "") {
        this.dropped.set("data", (this.dropped.get("data") ?? 0) + 1);
        return `<BLOB ${v.length}>`;
      }
    }
    return this.value(v, childPath);
  }
}
