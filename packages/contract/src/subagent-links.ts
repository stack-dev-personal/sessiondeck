import { SUBAGENT_ROWS_MAX } from "./limits";
import type { SubagentSnapshot } from "./snapshot";

/** True when following parent links up from `start` reaches `target` (bounded, so damaged data cannot hang it). */
export function reachesAgent(
  rows: readonly SubagentSnapshot[],
  start: string | null,
  target: string,
): boolean {
  const parents = new Map<string, string | null>();
  for (const r of rows) if (!parents.has(r.agent_id)) parents.set(r.agent_id, r.parent_agent_id);
  let cur = start;
  for (let hops = 0; cur !== null && hops <= Math.max(rows.length, SUBAGENT_ROWS_MAX); hops += 1) {
    if (cur === target) return true;
    cur = parents.get(cur) ?? null;
  }
  return false;
}

const unlink = (r: SubagentSnapshot): SubagentSnapshot =>
  r.parent_agent_id === null && !r.parent_known
    ? r
    : { ...r, parent_agent_id: null, parent_known: false };

/**
 * Makes the links of a row list consistent: a parent that is not an agent_id in the list becomes
 * null / unknown, as does every row on a parent cycle (including a self link). Used on every write
 * (after the cap) and on the stored read path, so both agree.
 */
export function normalizeSubagentLinks(rows: readonly SubagentSnapshot[]): SubagentSnapshot[] {
  const ids = new Set(rows.map((r) => r.agent_id));
  const dangling = rows.map((r) =>
    r.parent_agent_id !== null && !ids.has(r.parent_agent_id) ? unlink(r) : r,
  );
  return dangling.map((r) =>
    r.parent_agent_id !== null && reachesAgent(dangling, r.parent_agent_id, r.agent_id)
      ? unlink(r)
      : r,
  );
}
