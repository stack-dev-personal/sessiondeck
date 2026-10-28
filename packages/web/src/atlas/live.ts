import type { AtlasSession } from "./types";
import { atlasOf } from "./types";

/** Same value as LIVE_GRACE_MS in packages/hub/src/snapshots.ts (copied, not imported). */
export const LIVE_GRACE_MS = 10 * 60 * 1000;

/**
 * The hub's live rule (snapshots carry no ended_at; state_since is when it entered ended/exited) for sessions the REST list did not return: not archived; ended or exited
 * only within the grace period. The board never prunes, so web must apply it.
 */
export function isLive(s: AtlasSession, now: number): boolean {
  const state = s.state as string | null | undefined;
  if (state === "archived") return false;
  if (state !== "ended" && state !== "exited") return true;
  return (s.state_since || s.last_event_at || 0) >= now - LIVE_GRACE_MS;
}

/**
 * Live rows of a project: the REST list, each replaced by the realtime board copy when the board
 * has it; board sessions that moved out are dropped, ones that moved in are added.
 */
export function mergeLive(
  api: readonly AtlasSession[],
  board: Record<string, AtlasSession>,
  projectId: string,
  now: number = Date.now(),
): AtlasSession[] {
  const out = new Map<string, AtlasSession>();
  for (const s of api) {
    const b = board[s.session_id];
    const cur = b ?? s;
    if (atlasOf(cur).project_id === projectId) out.set(s.session_id, cur);
  }
  for (const s of Object.values(board)) {
    if (atlasOf(s).project_id === projectId && !out.has(s.session_id) && isLive(s, now))
      out.set(s.session_id, s);
  }
  return [...out.values()].sort(
    (a, b) => b.last_event_at - a.last_event_at || a.session_id.localeCompare(b.session_id),
  );
}

export const ARCHIVED_CAP = 20;
