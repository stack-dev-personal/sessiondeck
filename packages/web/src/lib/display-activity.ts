import type { SessionSnapshot, SessionState } from "@sessiondeck/contract";

/**
 * R3.10 display-level activity. The contract state machine is untouched (Stop still means idle);
 * this layer only decides what the board shows and how it orders. A session shows and sorts as
 * working until it has been continuously idle for the grace period. Waiting for input surfaces at
 * once. Terminal states (error, ended, exited) show at once too: holding them as "working" would
 * hide a failure or a dead session.
 */

export const DEFAULT_GRACE_SEC = 120;
export const MAX_GRACE_SEC = 15 * 60;

/** Clamp to whole seconds in 0..900; anything not a finite number gives the default. */
export function clampGraceSec(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_GRACE_SEC;
  return Math.min(MAX_GRACE_SEC, Math.max(0, Math.round(n)));
}

export type DisplayGroup = "attention" | "working" | "idle";
export const GROUP_RANK: Record<DisplayGroup, number> = { attention: 0, working: 1, idle: 2 };

export interface Tracked {
  /** The state the board shows: the raw state, except "working" while an idle is inside the grace. */
  displayState: SessionState;
  group: DisplayGroup;
  /** When the session entered its current group; the stable sort key inside a group. */
  groupSince: number;
  /** Start of the current uninterrupted idle run; null when not idle. */
  idleSince: number | null;
  /** When a raw move into working, held as idle, may show; null when no such hold is active. */
  wakeAt: number | null;
}

export type TrackedMap = ReadonlyMap<string, Tracked>;

export function groupOf(state: SessionState): DisplayGroup {
  if (state === "waiting_permission" || state === "waiting_input") return "attention";
  if (state === "working" || state === "starting") return "working";
  return "idle";
}

/** Advance one session. `prev` is undefined the first time it is seen (an idle younger than the grace is held from state_since). */
export function stepDisplay(
  prev: Tracked | undefined,
  s: SessionSnapshot,
  now: number,
  graceMs: number,
): Tracked {
  const raw = s.state;
  let displayState: SessionState = raw;
  let idleSince: number | null = null;
  let wakeAt: number | null = null;
  if (raw === "idle" && prev === undefined) {
    // First sight (mount, reload, back from Settings): the idle run began at the hub's state_since.
    // Clamped so clock skew between hub and browser never holds longer than one grace period.
    const since = Math.min(Math.max(s.state_since, now - graceMs), now);
    if (now - since < graceMs) {
      idleSince = since;
      displayState = "working";
    }
  } else if (
    (raw === "working" || raw === "starting") &&
    prev !== undefined &&
    prev.group === "idle" &&
    now - prev.groupSince < graceMs
  ) {
    // A card changes group at most once per grace period: hold the move back into working.
    displayState = "idle";
    wakeAt = prev.groupSince + graceMs;
  } else if (raw === "idle" && prev !== undefined && prev.group !== "idle") {
    // Left working or waiting for idle: hold as working until the idle has lasted the grace.
    idleSince = prev.idleSince ?? now;
    displayState = now - idleSince >= graceMs ? "idle" : "working";
  } else if (raw === "idle" && prev?.idleSince != null) {
    idleSince = prev.idleSince;
  }
  const group = groupOf(displayState);
  if (prev !== undefined && prev.group === group) {
    return { displayState, group, groupSince: prev.groupSince, idleSince, wakeAt };
  }
  // First sighting seeds the order from the hub's own state_since so a reload keeps a sane order.
  const groupSince = prev === undefined ? Math.min(s.state_since, now) : now;
  return { displayState, group, groupSince, idleSince, wakeAt };
}

/** Track every session; ids that vanished are dropped. Reuses the previous entry when unchanged. */
export function deriveDisplay(
  prev: TrackedMap,
  sessions: readonly SessionSnapshot[],
  now: number,
  graceMs: number,
): Map<string, Tracked> {
  const next = new Map<string, Tracked>();
  for (const s of sessions) {
    const before = prev.get(s.session_id);
    const t = stepDisplay(before, s, now, graceMs);
    next.set(
      s.session_id,
      before &&
        before.displayState === t.displayState &&
        before.group === t.group &&
        before.groupSince === t.groupSince &&
        before.idleSince === t.idleSince &&
        before.wakeAt === t.wakeAt
        ? before
        : t,
    );
  }
  return next;
}

/** Earliest time a held session flips to idle, or null when nothing is waiting on the clock. */
export function nextDeadline(map: TrackedMap, graceMs: number): number | null {
  let min: number | null = null;
  for (const t of map.values()) {
    if (t.wakeAt !== null && (min === null || t.wakeAt < min)) min = t.wakeAt;
    if (t.idleSince === null || t.displayState === "idle") continue;
    const at = t.idleSince + graceMs;
    if (min === null || at < min) min = at;
  }
  return min;
}

/** Group rank, then entered-group time (newest first), then session_id. Never reads last_event_at. */
export function sortDisplay(
  sessions: readonly SessionSnapshot[],
  map: TrackedMap,
): SessionSnapshot[] {
  const key = (s: SessionSnapshot) => map.get(s.session_id);
  return [...sessions].sort((a, b) => {
    const ta = key(a);
    const tb = key(b);
    const ra = ta ? GROUP_RANK[ta.group] : GROUP_RANK[groupOf(a.state)];
    const rb = tb ? GROUP_RANK[tb.group] : GROUP_RANK[groupOf(b.state)];
    if (ra !== rb) return ra - rb;
    const sa = ta?.groupSince ?? a.state_since;
    const sb = tb?.groupSince ?? b.state_since;
    if (sa !== sb) return sb - sa;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
}
