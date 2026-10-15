// Default-deny scrub of one parsed payload (R0.7). Pure apart from the Mapper's tables.
//
// Order of decisions for a string value at a normalized key path:
//   1. empty string: kept (carries nothing)
//   2. tool_name / agent / mcp / id / path keys: dedicated mapping
//   3. allowlist hit (fixture-allowlist.mjs KEEP) whose pattern matches: kept verbatim
//   4. whole value is a token: <REDACTED>; an email: <EMAIL>; account-like key: <ACCOUNT>
//   5. anything else: "<TEXT n>", n being the original length
// Numbers under an account-like or id-like key become 0; other numbers, booleans and null are kept.
// Object key names are default-deny too: a key survives only when listed in fixture-keys.mjs. An
// unknown identifier-like key becomes "<KEY_n>" and is reported (Scrubber.unknownKeys) so a person
// reviews it; a key that is user content (question text, file names with dots) becomes "<TEXT n>".
import {
  ACCOUNT_KEY,
  AGENT_KEYS,
  BUILTIN_AGENTS,
  BUILTIN_TOOLS,
  ID_KEYS,
  MCP_KEYS,
  PATH_KEYS,
  USER_KEYED,
  keepRule,
} from "./fixture-allowlist.mjs";
import { KNOWN_KEYS } from "./fixture-keys.mjs";
import { Mapper, mapId } from "./fixture-scrub-paths.mjs";

const ID_LIKE_KEY = /id$/i;
const SAFE_KEY = /^-?[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const TOKEN_PREFIX = /^(?:sk-|sk_|ghp_|gho_|ghs_|ghu_|github_pat_|AKIA|ASIA|xox[a-z]-|Bearer\s)/;
const LONG_RUN = /^[A-Za-z0-9+/_=-]{32,}$/;
const HEX_RUN = /^[A-Fa-f0-9]{32,}$/;

/** @param {string} v */
export function isToken(v) {
  return (
    TOKEN_PREFIX.test(v) ||
    HEX_RUN.test(v) ||
    (LONG_RUN.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v))
  );
}

/** @param {number} n */
const text = (n) => `<TEXT ${n}>`;

export class Scrubber {
  /** @param {Mapper} [mapper] */
  constructor(mapper = new Mapper()) {
    this.mapper = mapper;
    /** @type {Map<string, number>} path -> count of strings replaced by a TEXT placeholder */
    this.denied = new Map();
    /** @type {Map<string, number>} key path (unknown key shown as <KEY_n>) -> count of unknown keys */
    this.unknownKeys = new Map();
    /** Whether the payload being scrubbed names a built-in tool (set at the top level of value()). */
    this.builtinTool = false;
  }

  /**
   * @param {string} v string value
   * @param {string} path normalized key path
   * @returns {string}
   */
  string(v, path) {
    if (v === "") return v;
    const m = this.mapper;
    if (path === "tool_name") return m.mapTool(v, BUILTIN_TOOLS);
    if (MCP_KEYS.has(path)) return m.mapMcp(v);
    if (AGENT_KEYS.has(path)) return m.mapAgent(v, BUILTIN_AGENTS);
    if (ID_KEYS.has(path)) return mapId(v) ?? this.#deny(v, path);
    const pk = Object.hasOwn(PATH_KEYS, path) ? PATH_KEYS[path] : undefined;
    if (pk !== undefined) return m.mapPath(v, pk) ?? this.#deny(v, path);
    const rule = keepRule(path, this.builtinTool);
    if (rule?.re.test(v) === true && !isToken(v)) return v;
    if (isToken(v)) return "<REDACTED>";
    if (EMAIL.test(v)) return "<EMAIL>";
    if (ACCOUNT_KEY.test(path)) return "<ACCOUNT>";
    return this.#deny(v, path);
  }

  /** @param {string} v @param {string} path */
  #deny(v, path) {
    this.denied.set(path, (this.denied.get(path) ?? 0) + 1);
    return text(v.length);
  }

  /**
   * @param {unknown} value
   * @param {string} [path]
   * @returns {unknown}
   */
  value(value, path = "") {
    if (typeof value === "string") return this.string(value, path);
    if (typeof value === "number") return this.#number(value, path);
    if (Array.isArray(value)) return value.map((el) => this.value(el, `${path}[]`));
    if (value !== null && typeof value === "object") {
      const obj = /** @type {Record<string, unknown>} */ (value);
      if (path === "") this.builtinTool = BUILTIN_TOOLS.has(String(obj.tool_name));
      return this.#object(obj, path);
    }
    return value;
  }

  /** @param {number} n @param {string} path */
  #number(n, path) {
    const last = path.split(".").pop()?.replace(/\[\]$/, "") ?? "";
    return ACCOUNT_KEY.test(path) || ID_LIKE_KEY.test(last) ? 0 : n;
  }

  /** @param {Record<string, unknown>} obj @param {string} path */
  #object(obj, path) {
    const last = path.split(".").pop()?.replace(/\[\]$/, "") ?? "";
    const userKeyed = USER_KEYED.has(last);
    /** @type {Record<string, unknown>} */
    const out = {};
    const used = new Set();
    let unknown = 0;
    for (const key of Object.keys(obj)) {
      let outKey = key;
      if (userKeyed || key === "__proto__" || !SAFE_KEY.test(key)) {
        outKey = text(key.length);
        for (let n = 2; used.has(outKey); n += 1) outKey = `${text(key.length)}#${n}`;
      } else if (!KNOWN_KEYS.has(key)) {
        unknown += 1;
        outKey = `<KEY_${unknown}>`;
        const at = `${path === "" ? "" : `${path}.`}${outKey}`;
        this.unknownKeys.set(at, (this.unknownKeys.get(at) ?? 0) + 1);
      }
      used.add(outKey);
      const childPath =
        path === "" ? outKey : `${path}.${userKeyed || outKey.startsWith("<") ? "<key>" : outKey}`;
      out[outKey] = this.value(obj[key], childPath);
    }
    return out;
  }
}
