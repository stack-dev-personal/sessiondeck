// Typed reads from one parsed yaml mapping. Every failure names the sprint and the offending key.
import { inputError } from "./render-errors.mjs";

/**
 * A placeholder-shaped token such as {SPRINT_ID}: upper case letters, underscore, space. A package
 * value must not carry one (a "$" in front, as in ${CLAUDE_PROJECT_DIR}, marks shell syntax).
 */
export const PLACEHOLDER_SHAPE = /(?<!\$)\{[A-Z][A-Z_ ]*[A-Z]\}/;

/**
 * @param {unknown} v
 * @returns {string}
 */
export function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return typeof v === "object" ? "a mapping" : `${typeof v} ${JSON.stringify(v)}`;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isMapping(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads typed values from a mapping, throwing an error that names the sprint and key. */
export class Reader {
  /**
   * @param {Record<string, unknown>} map
   * @param {string} scope "sprint 2" or "sprint 2, sessions[1] (S8)"
   */
  constructor(map, scope) {
    this.map = map;
    this.scope = scope;
  }

  /**
   * @param {string} key
   * @param {string} expected
   * @param {unknown} got
   */
  bad(key, expected, got) {
    return inputError(
      `MINI-SPRINT-ORDER.md, ${this.scope}: key "${key}" must be ${expected} (got ${describe(got)})`,
    );
  }

  /**
   * Fails when the mapping has a key outside the known set, so a misspelling cannot drop a value.
   * @param {readonly string[]} known
   */
  rejectUnknownKeys(known) {
    const unknown = Object.keys(this.map).find((k) => !known.includes(k));
    if (unknown !== undefined) {
      throw inputError(
        `MINI-SPRINT-ORDER.md, ${this.scope}: unknown key "${unknown}"; known keys: ${known.join(", ")}`,
      );
    }
  }

  /**
   * @param {string} key
   * @param {boolean} required
   * @returns {unknown}
   */
  raw(key, required) {
    const v = this.map[key];
    if (v === undefined && required) {
      throw inputError(`MINI-SPRINT-ORDER.md, ${this.scope}: missing required key "${key}"`);
    }
    return v;
  }

  /**
   * A string that fits on one line and holds no placeholder token.
   * @param {string} key
   * @param {unknown} v
   * @returns {string}
   */
  text(key, v) {
    if (typeof v !== "string" || v.trim() === "") throw this.bad(key, "a non-empty string", v);
    if (v.includes("\n") || v.includes("\r")) {
      throw inputError(
        `MINI-SPRINT-ORDER.md, ${this.scope}: key "${key}" must be a single line (use a quoted string, not a block scalar)`,
      );
    }
    const token = PLACEHOLDER_SHAPE.exec(v);
    if (token !== null) {
      throw inputError(
        `MINI-SPRINT-ORDER.md, ${this.scope}: key "${key}" contains the placeholder ${token[0]}; ` +
          "values are data, so write the name without braces or put a $ in front",
      );
    }
    return v;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  str(key) {
    return this.text(key, this.raw(key, true));
  }

  /**
   * @param {string} key
   * @returns {string | undefined}
   */
  optStr(key) {
    const v = this.raw(key, false);
    return v === undefined ? undefined : this.text(key, v);
  }

  /**
   * @param {string} key
   * @returns {number}
   */
  int(key) {
    const v = this.raw(key, true);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw this.bad(key, "a non-negative integer", v);
    }
    return v;
  }

  /**
   * @param {string} key
   * @returns {number}
   */
  positiveInt(key) {
    const v = this.int(key);
    if (v < 1) throw this.bad(key, "an integer of at least 1", v);
    return v;
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  bool(key) {
    const v = this.raw(key, true);
    if (typeof v !== "boolean") throw this.bad(key, "true or false", v);
    return v;
  }

  /**
   * @param {string} key
   * @returns {boolean | undefined}
   */
  optBool(key) {
    const v = this.raw(key, false);
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw this.bad(key, "true or false", v);
    return v;
  }

  /**
   * @param {string} key
   * @returns {string[]}
   */
  strList(key) {
    return this.toStrList(key, this.raw(key, true));
  }

  /**
   * @param {string} key
   * @returns {string[] | undefined}
   */
  optStrList(key) {
    const v = this.raw(key, false);
    return v === undefined ? undefined : this.toStrList(key, v);
  }

  /**
   * @param {string} key
   * @param {unknown} v
   * @returns {string[]}
   */
  toStrList(key, v) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
      throw this.bad(key, "a list of non-empty strings", v);
    }
    return v.map((x) => this.text(key, x));
  }
}
