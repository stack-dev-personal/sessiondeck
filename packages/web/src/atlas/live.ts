import type { AtlasSession } from "./types";
import { atlasOf } from "./types";

/**
 * Live rows of a project: the REST list, each replaced by the realtime board copy when the board
 * has it; board sessions that moved out are dropped, ones that moved in are added.
 */
export function mergeLive(
  api: readonly AtlasSession[],
  board: Record<string, AtlasSession>,
  projectId: string,
): AtlasSession[] {
  const out = new Map<string, AtlasSession>();
  for (const s of api) {
    const b = board[s.session_id];
    const cur = b ?? s;
    if (atlasOf(cur).project_id === projectId) out.set(s.session_id, cur);
  }
  for (const s of Object.values(board)) {
    if (atlasOf(s).project_id === projectId && !out.has(s.session_id)) out.set(s.session_id, s);
  }
  return [...out.values()].sort(
    (a, b) => b.last_event_at - a.last_event_at || a.session_id.localeCompare(b.session_id),
  );
}

export const ARCHIVED_CAP = 20;
