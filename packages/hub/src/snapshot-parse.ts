import { readSubagentRows, readTracking, type SessionSnapshot } from "@sessiondeck/contract";

/**
 * The one way a stored snapshot JSON is parsed. Subagent rows stored before parent links existed
 * come out with parent_agent_id null and parent_known false (R3.11). Tracking is re-read so retired fields (pending_spawns, pending_tainted,
 * ambiguous_remaining) from older snapshots are dropped. Damaged stored data (a
 * non-object snapshot, a non-array subagents, null or scalar elements) is dropped, never thrown.
 */
export function parseStoredSnapshot(raw: string): SessionSnapshot {
  const s = JSON.parse(raw) as SessionSnapshot;
  if (typeof s !== "object" || s === null) return s;
  s.subagents = readSubagentRows(s.subagents);
  s.tracking = readTracking(s.tracking);
  return s;
}
