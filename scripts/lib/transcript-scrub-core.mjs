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
  MODEL_KEYED,
  SPECIAL,
  USER_KEYED,
} from "./transcript-scrub-rules.mjs";
import { TextScrubber } from "./transcript-scrub-text.mjs";

const SAFE_KEY = /^-?[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
const MODEL_KEY = /^claude-[a-z0-9.-]{1,40}$/;
const TOKEN_SHAPE =
  /^(?:sk[-_]|ghp_|gho_|ghs_|ghu_|github_pat_|AKIA|ASIA|xox[a-z]-|Bearer\s)|[A-Fa-f0-9]{32,}/;
/** Path segment standing for a key name that is not in TRANSCRIPT_KEYS. */
const UNKNOWN_SEGMENT = "<unknown>";
export const THINKING_PLACEHOLDER = "<REDACTED-THINKING>";

const text = (/** @type {number} */ n) => `<TEXT ${n}>`;

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
  }

  /** Scrubs one parsed row (or meta object). @param {unknown} row @returns {unknown} */
  row(row) {
    return this.value(row, "");
  }

  /** @param {unknown} value @param {string} path @returns {unknown} */
  value(value, path) {
    if (typeof value === "string") return this.#string(value, path);
    if (Array.isArray(value)) return value.map((el) => this.value(el, `${path}[]`));
    if (value !== null && typeof value === "object") {
      return this.#object(/** @type {Record<string, unknown>} */ (value), path);
    }
    return value; // numbers, booleans and null carry structure only
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
        return rule.re?.test(v) === true && !TOKEN_SHAPE.test(v) ? v : this.#deny(v, path);
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
      out[outKey] = this.#child(key, child, childPath, path, type);
    }
    return out;
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
