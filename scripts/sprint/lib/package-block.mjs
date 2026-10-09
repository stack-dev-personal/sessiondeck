// Parses and validates one sprint package block from MINI-SPRINT-ORDER.md.
// Every failure names the sprint and the offending key.
import { parse } from "yaml";
import { inputError } from "./render-errors.mjs";

export const RUNS_IN_VALUES = Object.freeze(["local", "container"]);

/**
 * @typedef {object} SessionSpec
 * @property {string} id
 * @property {string} handoff
 * @property {string} branch
 * @property {number} phase
 * @property {string[]} depends_on
 * @property {boolean} security_gated
 * @property {string} [lane]
 * @property {string} [goal]
 * @property {boolean} [optional]
 * @property {string} [user_gate]
 */

/**
 * @typedef {object} SprintPackage
 * @property {string} sprint
 * @property {string} name
 * @property {string} slug
 * @property {string} branch
 * @property {string[]} depends_on
 * @property {string[]} user_gates
 * @property {number} max_parallel
 * @property {string} runs_in
 * @property {SessionSpec[]} sessions
 * @property {string[]} merge_order
 * @property {string[]} integration_checks
 * @property {string[]} [needs_laptop]
 * @property {string} [notes]
 */

/**
 * @param {unknown} v
 * @returns {string}
 */
function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return typeof v === "object" ? "a mapping" : `${typeof v} ${JSON.stringify(v)}`;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isMapping(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads typed values from a mapping, throwing an error that names the sprint and key. */
class Reader {
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
   * @param {string} key
   * @returns {string}
   */
  str(key) {
    const v = this.raw(key, true);
    if (typeof v !== "string" || v.trim() === "") throw this.bad(key, "a non-empty string", v);
    return v;
  }

  /**
   * @param {string} key
   * @returns {string | undefined}
   */
  optStr(key) {
    const v = this.raw(key, false);
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim() === "") throw this.bad(key, "a non-empty string", v);
    return v;
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
    return /** @type {string[]} */ (v);
  }
}

/**
 * @param {unknown} raw
 * @param {string} sprintLabel
 * @param {number} index
 * @returns {SessionSpec}
 */
function readSession(raw, sprintLabel, index) {
  const at = `sessions[${index}]`;
  if (!isMapping(raw)) {
    throw inputError(
      `MINI-SPRINT-ORDER.md, ${sprintLabel}: key "${at}" must be a mapping (got ${describe(raw)})`,
    );
  }
  const idHint = typeof raw.id === "string" ? ` (${raw.id})` : "";
  const r = new Reader(raw, `${sprintLabel}, ${at}${idHint}`);
  const lane = r.optStr("lane");
  const goal = r.optStr("goal");
  const optional = r.optBool("optional");
  const userGate = r.optStr("user_gate");
  return {
    id: r.str("id"),
    handoff: r.str("handoff"),
    branch: r.str("branch"),
    phase: r.int("phase"),
    depends_on: r.strList("depends_on"),
    security_gated: r.bool("security_gated"),
    ...(lane === undefined ? {} : { lane }),
    ...(goal === undefined ? {} : { goal }),
    ...(optional === undefined ? {} : { optional }),
    ...(userGate === undefined ? {} : { user_gate: userGate }),
  };
}

/**
 * @param {Reader} r
 * @param {string} sprintLabel
 * @returns {SessionSpec[]}
 */
function readSessions(r, sprintLabel) {
  const raw = r.raw("sessions", true);
  if (!Array.isArray(raw) || raw.length === 0) throw r.bad("sessions", "a non-empty list", raw);
  const sessions = raw.map((s, i) => readSession(s, sprintLabel, i));
  const ids = sessions.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    throw inputError(`MINI-SPRINT-ORDER.md, ${sprintLabel}: key "sessions" repeats id "${dup}"`);
  }
  return sessions;
}

/**
 * @param {string} yamlText
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseMapping(yamlText, label) {
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(yamlText);
  } catch (error) {
    const detail = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    throw inputError(`MINI-SPRINT-ORDER.md, ${label}: the yaml does not parse (${detail})`);
  }
  if (!isMapping(doc)) {
    throw inputError(`MINI-SPRINT-ORDER.md, ${label}: the yaml block must be a mapping`);
  }
  return doc;
}

/**
 * Parses the yaml text of a package block and checks its shape.
 * @param {string} yamlText
 * @param {string} headingId the id in the "### Sprint N" heading; must equal the sprint key
 * @returns {SprintPackage}
 */
export function parsePackageBlock(yamlText, headingId) {
  const label = `sprint ${headingId}`;
  const r = new Reader(parseMapping(yamlText, label), label);
  const sprint = r.str("sprint");
  if (sprint !== headingId) {
    throw inputError(
      `MINI-SPRINT-ORDER.md, ${label}: key "sprint" is "${sprint}" but the heading says "${headingId}"`,
    );
  }
  const runsIn = r.str("runs_in");
  if (!RUNS_IN_VALUES.includes(runsIn)) {
    throw r.bad("runs_in", `one of ${RUNS_IN_VALUES.join(", ")}`, runsIn);
  }
  const sessions = readSessions(r, label);
  const mergeOrder = r.strList("merge_order");
  const known = new Set(sessions.map((s) => s.id));
  const stray = mergeOrder.find((id) => !known.has(id));
  if (stray !== undefined) {
    throw inputError(
      `MINI-SPRINT-ORDER.md, ${label}: key "merge_order" names "${stray}", which is not a session id`,
    );
  }
  const needsLaptop = r.optStrList("needs_laptop");
  const notes = r.optStr("notes");
  return {
    sprint,
    name: r.str("name"),
    slug: r.str("slug"),
    branch: r.str("branch"),
    depends_on: r.strList("depends_on"),
    user_gates: r.strList("user_gates"),
    max_parallel: r.positiveInt("max_parallel"),
    runs_in: runsIn,
    sessions,
    merge_order: mergeOrder,
    integration_checks: r.strList("integration_checks"),
    ...(needsLaptop === undefined ? {} : { needs_laptop: needsLaptop }),
    ...(notes === undefined ? {} : { notes }),
  };
}
