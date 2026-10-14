// Parses and validates one sprint package block from MINI-SPRINT-ORDER.md.
// Every failure names the sprint and the offending key.
import { parse } from "yaml";
import { inputError } from "./render-errors.mjs";
import { Reader, describe, isMapping } from "./reader.mjs";

export const RUNS_IN_VALUES = Object.freeze(["local", "container"]);

const SESSION_KEYS = Object.freeze([
  "id",
  "handoff",
  "branch",
  "phase",
  "depends_on",
  "security_gated",
  "lane",
  "goal",
  "optional",
  "user_gate",
]);

const PACKAGE_KEYS = Object.freeze([
  "sprint",
  "name",
  "slug",
  "branch",
  "depends_on",
  "user_gates",
  "max_parallel",
  "runs_in",
  "sessions",
  "merge_order",
  "integration_checks",
  "needs_laptop",
  "notes",
]);

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
  r.rejectUnknownKeys(SESSION_KEYS);
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
  for (const [i, s] of sessions.entries()) {
    const stray = s.depends_on.find((d) => !ids.includes(d) || d === s.id);
    if (stray !== undefined) {
      const why = stray === s.id ? "the session itself" : "not a session id in this sprint";
      throw inputError(
        `MINI-SPRINT-ORDER.md, ${sprintLabel}, sessions[${i}] (${s.id}): key "depends_on" names "${stray}", which is ${why}`,
      );
    }
  }
  checkNoCycle(
    new Map(sessions.map((s) => [s.id, s.depends_on])),
    `MINI-SPRINT-ORDER.md, ${sprintLabel}`,
    "session",
  );
  return sessions;
}

/**
 * A depends_on cycle means nothing in it can ever start.
 * @param {Map<string, string[]>} deps id to the ids it depends on
 * @param {string} where start of the error message, for example "MINI-SPRINT-ORDER.md, sprint 2"
 * @param {string} unit what the ids are: "session" or "sprint"
 */
export function checkNoCycle(deps, where, unit) {
  /** @type {Set<string>} */
  const done = new Set();
  /** @param {string} id @param {string[]} path */
  const visit = (id, path) => {
    const at = path.indexOf(id);
    if (at !== -1) {
      const loop = [...path.slice(at), id].join(" -> ");
      throw inputError(
        `${where}: key "depends_on" forms a cycle (${loop}), so no ${unit} in it could start`,
      );
    }
    if (done.has(id)) return;
    for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
    done.add(id);
  };
  for (const id of deps.keys()) visit(id, []);
}

/**
 * merge_order must list every session exactly once, or a session is never merged.
 * @param {string[]} mergeOrder
 * @param {SessionSpec[]} sessions
 * @param {string} label
 */
function checkMergeOrder(mergeOrder, sessions, label) {
  const ids = sessions.map((s) => s.id);
  const fail = (/** @type {string} */ detail) =>
    inputError(`MINI-SPRINT-ORDER.md, ${label}: key "merge_order" ${detail}`);
  const stray = mergeOrder.find((id) => !ids.includes(id));
  if (stray !== undefined) throw fail(`names "${stray}", which is not a session id`);
  const dup = mergeOrder.find((id, i) => mergeOrder.indexOf(id) !== i);
  if (dup !== undefined) throw fail(`repeats "${dup}"`);
  const missing = ids.find((id) => !mergeOrder.includes(id));
  if (missing !== undefined) throw fail(`omits session "${missing}", which would never be merged`);
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
  r.rejectUnknownKeys(PACKAGE_KEYS);
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
  checkMergeOrder(mergeOrder, sessions, label);
  const slug = r.str("slug");
  const branch = r.str("branch");
  const expectedBranch = `sprint/${sprint}-${slug}`;
  if (branch !== expectedBranch) {
    throw inputError(
      `MINI-SPRINT-ORDER.md, ${label}: key "branch" is "${branch}" but the prompt checks out "${expectedBranch}" (sprint-slug)`,
    );
  }
  const checks = r.strList("integration_checks");
  if (checks.length === 0) {
    throw inputError(
      `MINI-SPRINT-ORDER.md, ${label}: key "integration_checks" must list at least one check`,
    );
  }
  const needsLaptop = r.optStrList("needs_laptop");
  const notes = r.optStr("notes");
  return {
    sprint,
    name: r.str("name"),
    slug,
    branch,
    depends_on: r.strList("depends_on"),
    user_gates: r.strList("user_gates"),
    max_parallel: r.positiveInt("max_parallel"),
    runs_in: runsIn,
    sessions,
    merge_order: mergeOrder,
    integration_checks: checks,
    ...(needsLaptop === undefined ? {} : { needs_laptop: needsLaptop }),
    ...(notes === undefined ? {} : { notes }),
  };
}
