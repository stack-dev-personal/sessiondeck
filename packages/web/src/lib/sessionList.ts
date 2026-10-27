import { SESSION_STATES, type SessionState } from "@sessiondeck/contract";
import { carryAtlas, atlasOf, type AtlasSession } from "../atlas/types";
import { displayNameOf, projectOf } from "./attention";

export const SORT_KEYS = ["activity", "started", "project", "state"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const RANGES = ["all", "today", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

export const SORT_LABEL: Record<SortKey, string> = {
  activity: "Last activity",
  started: "Started",
  project: "Project",
  state: "State",
};
export const RANGE_LABEL: Record<Range, string> = {
  all: "All time",
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** The list view's filters and sort; mirrored in the URL query so a view is linkable. */
export interface ListQuery {
  host: string | null;
  /** Project id (the hub's `p_...`). */
  project: string | null;
  phase: string | null;
  state: SessionState | null;
  range: Range;
  sort: SortKey;
  /** Free-text filter over name, project, branch, host and id. */
  q: string;
}

export const DEFAULT_QUERY: ListQuery = {
  host: null,
  project: null,
  phase: null,
  state: null,
  range: "all",
  sort: "activity",
  q: "",
};

const text = (p: URLSearchParams, k: string): string | null => {
  const v = p.get(k);
  return v !== null && v !== "" ? v.slice(0, 200) : null;
};

export function parseListQuery(p: URLSearchParams): ListQuery {
  const state = p.get("state");
  const range = p.get("range");
  const sort = p.get("sort");
  return {
    host: text(p, "host"),
    project: text(p, "project"),
    phase: text(p, "phase"),
    state: (SESSION_STATES as readonly string[]).includes(state ?? "")
      ? (state as SessionState)
      : null,
    range: (RANGES as readonly string[]).includes(range ?? "") ? (range as Range) : "all",
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? "") ? (sort as SortKey) : "activity",
    q: (p.get("q") ?? "").slice(0, 200),
  };
}

/** Non-default fields only, so the URL of an unfiltered list is just /sessions. */
export function listQueryParams(q: ListQuery, keep?: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams();
  if (q.host) p.set("host", q.host);
  if (q.project) p.set("project", q.project);
  if (q.phase) p.set("phase", q.phase);
  if (q.state) p.set("state", q.state);
  if (q.range !== "all") p.set("range", q.range);
  if (q.sort !== "activity") p.set("sort", q.sort);
  if (q.q !== "") p.set("q", q.q);
  const open = keep?.get("open");
  if (open) p.set("open", open);
  return p;
}

export function activeFilterCount(q: ListQuery): number {
  return [q.host, q.project, q.phase, q.state, q.range !== "all" ? 1 : null, q.q || null].filter(
    (v) => v !== null,
  ).length;
}

/** Hub rows (every session, ended and archived too) with the realtime board copy winning; board-only sessions are added. */
export function mergeSessions(
  hub: readonly AtlasSession[] | null,
  board: Record<string, AtlasSession>,
): AtlasSession[] {
  const out = new Map<string, AtlasSession>();
  for (const h of hub ?? []) out.set(h.session_id, h);
  for (const [id, b] of Object.entries(board)) {
    const h = out.get(id);
    out.set(id, carryAtlas(b, h) as AtlasSession);
  }
  return [...out.values()];
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function rangeSince(range: Range, now: number): number {
  switch (range) {
    case "today":
      return startOfDay(now);
    case "7d":
      return now - 7 * 86_400_000;
    case "30d":
      return now - 30 * 86_400_000;
    default:
      return -Infinity;
  }
}

const STATE_RANK = new Map<string, number>(SESSION_STATES.map((s, i) => [s, i]));

export function matchesText(s: AtlasSession, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  const hay = [
    displayNameOf(s),
    projectOf(s),
    s.git.branch ?? "",
    s.host,
    s.session_id,
    atlasOf(s).phase ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return needle.split(/\s+/).every((t) => hay.includes(t));
}

/** Filters then sorts; ties always break by session id so the order is total and stable. */
export function applyListQuery(
  rows: readonly AtlasSession[],
  q: ListQuery,
  now: number,
): AtlasSession[] {
  const since = rangeSince(q.range, now);
  const out = rows.filter((s) => {
    const a = atlasOf(s);
    return (
      (q.host === null || s.host === q.host) &&
      (q.project === null || a.project_id === q.project) &&
      (q.phase === null || a.phase === q.phase) &&
      (q.state === null || s.state === q.state) &&
      s.last_event_at >= since &&
      matchesText(s, q.q)
    );
  });
  const byId = (a: AtlasSession, b: AtlasSession) =>
    a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  const cmp: Record<SortKey, (a: AtlasSession, b: AtlasSession) => number> = {
    activity: (a, b) => b.last_event_at - a.last_event_at || byId(a, b),
    started: (a, b) => b.started_at - a.started_at || byId(a, b),
    project: (a, b) =>
      projectOf(a).localeCompare(projectOf(b)) || b.last_event_at - a.last_event_at || byId(a, b),
    state: (a, b) =>
      (STATE_RANK.get(a.state) ?? 99) - (STATE_RANK.get(b.state) ?? 99) ||
      b.last_event_at - a.last_event_at ||
      byId(a, b),
  };
  return out.sort(cmp[q.sort]);
}
