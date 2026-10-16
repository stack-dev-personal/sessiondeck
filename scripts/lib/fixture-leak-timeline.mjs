// Schema check for expected-timeline files (sessions/*.timeline.json), part of the R0.7 gate.
//
// These files are hand-written, so the payload structure check does not apply, but they must not
// become a place where free text or an unreviewed field can sit. Exact key sets at every level;
// every string comes from a closed list or a narrow pattern. Reports a count of violations under
// one category and never the offending value.
import { BUILTIN_AGENTS, BUILTIN_TOOLS } from "./fixture-allowlist.mjs";
import { HOOK_EVENTS } from "./hook-events.mjs";

export const TIMELINE_CATEGORY = "timeline-schema";

const STATES = new Set([
  "starting",
  "working",
  "waiting_permission",
  "waiting_input",
  "idle",
  "error",
  "ended",
  "exited",
]);
const CONTEXTS = new Set(["main", "subagent"]);
const ENDED_REASONS = new Set([
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "bypass_permissions_disabled",
  "other",
  "superseded",
  "unknown",
]);
const STATE_DETAIL = /^(?:tool|source|compact):[A-Za-z_]+$/;
const MODEL_ID = /^claude-[a-z0-9.-]{1,50}$/;

const TOP_KEYS = ["events", "changes", "final"];
const CHANGE_KEYS = ["index", "event", "context", "from", "to", "state_detail", "row"];
const FINAL_KEYS = [
  "state",
  "state_since_index",
  "state_detail",
  "ended_reason",
  "last_event_index",
  "compactions",
  "tasks",
  "model_id",
  "tracking",
  "subagents",
];
const TASK_KEYS = ["total", "completed", "last_subject"];
const TRACKING_KEYS = ["last_tool", "permission"];
const SUBAGENT_KEYS = ["agent_type", "started_index", "ended_index"];

const isObject = (/** @type {unknown} */ v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
const isNullOr = (/** @type {unknown} */ v, /** @type {(x: unknown) => boolean} */ ok) =>
  v === null || ok(v);
const inSet =
  (/** @type {Set<string> | ReadonlySet<string>} */ set) => (/** @type {unknown} */ v) =>
    typeof v === "string" && set.has(v);
const matches = (/** @type {RegExp} */ re) => (/** @type {unknown} */ v) =>
  typeof v === "string" && re.test(v);

/** True when `o` is an object with exactly these keys. */
const exactKeys = (/** @type {unknown} */ o, /** @type {string[]} */ keys) =>
  isObject(o) &&
  Object.keys(/** @type {object} */ (o))
    .sort()
    .join("|") === [...keys].sort().join("|");

/**
 * @param {unknown} doc parsed timeline file
 * @param {(category: string, n?: number) => void} hit
 */
export function checkTimeline(doc, hit) {
  /** @param {boolean} ok */
  const need = (ok) => {
    if (!ok) hit(TIMELINE_CATEGORY);
  };
  if (!exactKeys(doc, TOP_KEYS)) return hit(TIMELINE_CATEGORY);
  const t = /** @type {Record<string, any>} */ (doc);
  need(isCount(t.events));
  if (!Array.isArray(t.changes)) return hit(TIMELINE_CATEGORY);
  for (const c of t.changes) {
    if (!exactKeys(c, CHANGE_KEYS)) {
      hit(TIMELINE_CATEGORY);
      continue;
    }
    need(isCount(c.index) && isCount(c.row));
    need(inSet(new Set(HOOK_EVENTS))(c.event) && inSet(CONTEXTS)(c.context));
    need(inSet(STATES)(c.from) && inSet(STATES)(c.to));
    need(isNullOr(c.state_detail, matches(STATE_DETAIL)));
  }
  const f = t.final;
  if (!exactKeys(f, FINAL_KEYS)) return hit(TIMELINE_CATEGORY);
  need(inSet(STATES)(f.state) && isNullOr(f.state_detail, matches(STATE_DETAIL)));
  need(isNullOr(f.ended_reason, inSet(ENDED_REASONS)));
  need(isCount(f.state_since_index) && isCount(f.last_event_index) && isCount(f.compactions));
  need(isNullOr(f.model_id, matches(MODEL_ID)));
  need(exactKeys(f.tasks, TASK_KEYS));
  if (isObject(f.tasks))
    need(isCount(f.tasks.total) && isCount(f.tasks.completed) && f.tasks.last_subject === null);
  need(exactKeys(f.tracking, TRACKING_KEYS));
  if (isObject(f.tracking))
    need(isNullOr(f.tracking.last_tool, inSet(BUILTIN_TOOLS)) && f.tracking.permission === null);
  if (!Array.isArray(f.subagents)) return hit(TIMELINE_CATEGORY);
  for (const a of f.subagents) {
    if (!exactKeys(a, SUBAGENT_KEYS)) {
      hit(TIMELINE_CATEGORY);
      continue;
    }
    need(a.agent_type === "" || inSet(BUILTIN_AGENTS)(a.agent_type));
    need(isCount(a.started_index) && isNullOr(a.ended_index, isCount));
  }
}
