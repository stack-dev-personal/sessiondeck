import { readSubagentRow, type SessionSnapshot } from "@sessiondeck/contract";

/**
 * The one way a stored snapshot JSON is parsed. Subagent rows stored before parent links existed
 * come out with parent_agent_id null and parent_known false (R3.11).
 */
export function parseStoredSnapshot(raw: string): SessionSnapshot {
  const s = JSON.parse(raw) as SessionSnapshot;
  if (Array.isArray(s.subagents)) s.subagents = s.subagents.map(readSubagentRow);
  return s;
}
