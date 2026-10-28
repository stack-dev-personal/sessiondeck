import { readSubagentRow, type SessionSnapshot } from "@sessiondeck/contract";

/**
 * The one way a stored snapshot JSON is parsed. Subagent rows stored before parent links existed
 * come out with parent_agent_id null and parent_known false (R3.11). Damaged stored data (a
 * non-object snapshot, a non-array subagents, null or scalar elements) is dropped, never thrown.
 */
export function parseStoredSnapshot(raw: string): SessionSnapshot {
  const s = JSON.parse(raw) as SessionSnapshot;
  if (typeof s !== "object" || s === null) return s;
  const subs: unknown = s.subagents;
  s.subagents = Array.isArray(subs)
    ? subs.filter((x) => typeof x === "object" && x !== null).map(readSubagentRow)
    : [];
  return s;
}
