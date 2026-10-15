// Deterministic selection of the committed fixture set from the raw captures (R0.7).
import { keysOf } from "./fixture-files.mjs";

/** @typedef {{ file: string, epoch: number, short: string, payload: any }} RawItem */
/** @typedef {{ dir: string, tag: string, item: RawItem }} Pick */

const TOOL_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PostToolUseFailure",
]);
/** Per-event payload field whose value splits otherwise identical key sets. */
const DISCRIMINATOR = {
  Notification: "notification_type",
  SessionStart: "source",
  SessionEnd: "reason",
  PreCompact: "trigger",
  PostCompact: "trigger",
};

/** @param {unknown} v */
function shapeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v === "object" ? `{${keysOf(v).join(",")}}` : typeof v;
}

/**
 * Selection signature of one hook payload: top-level key set plus the per-event discriminator.
 * Tool events add the tool and the shapes of tool_input / tool_response.
 * @param {string} event
 * @param {any} p
 */
export function groupKey(event, p) {
  const parts = [keysOf(p).join(",")];
  if (TOOL_EVENTS.has(event)) {
    const name = String(p.tool_name ?? "");
    parts.push(name.startsWith("mcp__") ? "mcp" : name, shapeOf(p.tool_input));
    if (event === "PostToolUse") parts.push(shapeOf(p.tool_response));
    if (event === "PostToolUseFailure") parts.push(`interrupt=${String(p.is_interrupt)}`);
  }
  if (Object.hasOwn(DISCRIMINATOR, event)) {
    parts.push(String(p[DISCRIMINATOR[/** @type {keyof typeof DISCRIMINATOR} */ (event)]]));
  }
  if (event === "SubagentStop") parts.push(`type_empty=${p.agent_type === ""}`);
  return parts.join("|");
}

/** Smallest serialized payload first (least content to scrub), then file name. */
function bySize(/** @type {RawItem} */ a, /** @type {RawItem} */ b) {
  const d = JSON.stringify(a.payload).length - JSON.stringify(b.payload).length;
  return d !== 0 ? d : a.file < b.file ? -1 : 1;
}

/**
 * One representative per group for a hook event.
 * @param {string} event
 * @param {RawItem[]} items
 * @returns {Pick[]}
 */
export function pickHookGroups(event, items) {
  /** @type {Map<string, RawItem[]>} */
  const groups = new Map();
  for (const it of items) {
    const k = groupKey(event, it.payload);
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .flatMap(([, members]) => {
      const item = [...members].sort(bySize)[0];
      return item ? [{ dir: event, tag: "", item }] : [];
    });
}

/** @param {any} r */
const interruptedOrError = (r) =>
  r !== null &&
  typeof r === "object" &&
  (r.interrupted === true || r.is_error === true || r.isError === true);

/**
 * Extra hook picks the unit asks for beyond one-per-group.
 * @param {Map<string, RawItem[]>} byEvent
 * @returns {Pick[]}
 */
export function pickExtras(byEvent) {
  /** @type {Pick[]} */
  const extras = [];
  const post = byEvent.get("PostToolUse") ?? [];
  const hit = post.filter((i) => interruptedOrError(i.payload.tool_response)).sort(bySize)[0];
  if (hit) extras.push({ dir: "PostToolUse", tag: "interrupted", item: hit });
  const ask = post.find((i) => i.payload.tool_name === "AskUserQuestion");
  if (ask) {
    const stop = (byEvent.get("Stop") ?? []).find(
      (s) =>
        s.payload.session_id === ask.payload.session_id &&
        s.epoch >= ask.epoch &&
        s.payload.agent_id === undefined,
    );
    if (stop) extras.push({ dir: "Stop", tag: "after-ask", item: stop });
  }
  return extras;
}

/** Capture order: epoch from the file name, then file name. */
const byCapture = (/** @type {{ item: RawItem }} */ a, /** @type {{ item: RawItem }} */ b) =>
  a.item.epoch - b.item.epoch || (a.item.file < b.item.file ? -1 : 1);

/**
 * Chooses the golden session: first event SessionStart, last event SessionEnd, at most maxEvents hook events, and
 * the most distinct event types (ties: fewer events, then session id order).
 * @param {Map<string, RawItem[]>} byEvent hook events only
 * @param {number} maxEvents
 * @returns {{ sessionId: string, events: { event: string, item: RawItem }[] } | null}
 */
export function pickGolden(byEvent, maxEvents) {
  /** @type {Map<string, { event: string, item: RawItem }[]>} */
  const by = new Map();
  for (const [event, items] of byEvent) {
    for (const item of items) {
      const sid = String(item.payload.session_id);
      by.set(sid, [...(by.get(sid) ?? []), { event, item }]);
    }
  }
  /** @type {{ sid: string, list: { event: string, item: RawItem }[], score: number } | null} */
  let best = null;
  for (const [sid, list] of [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ordered = [...list].sort(byCapture);
    const types = new Set(list.map((e) => e.event));
    const complete = ordered[0]?.event === "SessionStart" && ordered.at(-1)?.event === "SessionEnd";
    if (!complete || list.length > maxEvents) continue;
    const score = types.size * 10000 - list.length;
    if (best === null || score > best.score) best = { sid, list: ordered, score };
  }
  if (best === null) return null;
  return { sessionId: best.sid, events: best.list };
}

/** @param {any} p */
const used = (p) => p.context_window?.used_percentage;

/**
 * 20 statusLine samples spanning sessions. Spec cases first, then even spacing to fill.
 * @param {RawItem[]} status statusLine items in capture order
 * @param {RawItem[]} compacts PostCompact items
 * @param {number} want
 * @returns {Pick[]}
 */
export function pickStatusLine(status, compacts, want) {
  /** @type {Pick[]} */
  const picks = [];
  const seen = new Set();
  const add = (/** @type {RawItem | undefined} */ item, /** @type {string} */ tag) => {
    if (item && !seen.has(item.file) && picks.length < want) {
      seen.add(item.file);
      picks.push({ dir: "statusLine", tag, item });
    }
  };
  /** @type {Map<string, RawItem[]>} */
  const sessions = new Map();
  for (const it of status) {
    sessions.set(it.payload.session_id, [...(sessions.get(it.payload.session_id) ?? []), it]);
  }
  const maxBy = (/** @type {(p: any) => unknown} */ f) =>
    status
      .filter((i) => typeof f(i.payload) === "number")
      .sort((a, b) => Number(f(b.payload)) - Number(f(a.payload)) || (a.file < b.file ? -1 : 1))[0];
  add(maxBy(used), "max-used");
  add(
    maxBy((p) => p.rate_limits?.five_hour?.used_percentage),
    "max-five-hour",
  );
  add(
    maxBy((p) => p.rate_limits?.seven_day?.used_percentage),
    "max-seven-day",
  );
  add(
    status.find((i) => i.payload.context_window?.current_usage === null),
    "usage-null",
  );
  /** @type {Set<string>} */
  const sets = new Set();
  for (const it of status) {
    const k = `${keysOf(it.payload).join(",")}|rl=${it.payload.rate_limits != null}`;
    if (!sets.has(k)) {
      sets.add(k);
      add(it, it.payload.rate_limits == null ? "keyset-no-rate-limits" : "keyset");
    }
  }
  for (const c of compacts) {
    add(
      (sessions.get(c.payload.session_id) ?? []).find((i) => i.epoch > c.epoch),
      "after-compact",
    );
  }
  const ordered = [...sessions.values()].sort((a, b) => (a[0]?.epoch ?? 0) - (b[0]?.epoch ?? 0));
  for (const list of ordered) add(list[0], "first-tick");
  for (const list of ordered) add(list[Math.floor(list.length / 2)], "mid");
  const rest = status.filter((i) => !seen.has(i.file));
  const gap = Math.max(1, Math.floor(rest.length / Math.max(1, want - picks.length)));
  for (let i = 0; i < rest.length && picks.length < want; i += gap) add(rest[i], "spread");
  return picks;
}

/**
 * Subagent status samples: distinct sessions and row counts first, then earliest to fill.
 * @param {RawItem[]} items
 * @param {number} want
 * @returns {Pick[]}
 */
export function pickSubagentStatus(items, want) {
  const rowsOf = (/** @type {RawItem} */ i) =>
    Array.isArray(i.payload.tasks) ? i.payload.tasks.length : 0;
  const byRows = [...items].sort((a, b) => rowsOf(b) - rowsOf(a) || a.epoch - b.epoch);
  /** @type {Pick[]} */
  const picks = [];
  const sessions = new Set();
  const rowCounts = new Set();
  for (const it of byRows) {
    if (picks.length < want && !rowCounts.has(rowsOf(it)) && !sessions.has(it.payload.session_id)) {
      rowCounts.add(rowsOf(it));
      sessions.add(it.payload.session_id);
      picks.push({ dir: "subagentStatusLine", tag: `rows-${rowsOf(it)}`, item: it });
    }
  }
  for (const it of [...items].sort((a, b) => a.epoch - b.epoch)) {
    if (picks.length < want && !picks.some((p) => p.item.file === it.file)) {
      picks.push({ dir: "subagentStatusLine", tag: `rows-${rowsOf(it)}`, item: it });
    }
  }
  return picks;
}
