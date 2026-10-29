import type { SubagentSnapshot } from "@sessiondeck/contract";

export interface AgentNode {
  row: SubagentSnapshot;
  children: AgentNode[];
  /** Parent not known or not present: the row sits at the first level with an "unlinked" marker. */
  unlinked: boolean;
  depth: number;
}

/** Defence in depth: the contract normalizes links, the UI still never recurses past this. */
export const MAX_AGENT_DEPTH = 32;

/**
 * Builds the rollup forest (R3.11). A row nests under its parent only when parent_known is true
 * and the parent is a row in the list. parent_known with a null parent means the main thread spawned
 * it: first level, not unlinked. Anything else (unknown parent, missing parent) is first level and
 * unlinked. Rows unreachable from a root (a parent cycle the contract failed to break) are promoted
 * to the first level as unlinked, and depth is capped, so damaged data cannot hang the render.
 */
export function buildAgentTree(rows: readonly SubagentSnapshot[]): AgentNode[] {
  const byId = new Map<string, SubagentSnapshot>();
  for (const r of rows) if (!byId.has(r.agent_id)) byId.set(r.agent_id, r);
  const kids = new Map<string, SubagentSnapshot[]>();
  const roots: { row: SubagentSnapshot; unlinked: boolean }[] = [];
  for (const r of byId.values()) {
    const p = r.parent_agent_id;
    if (r.parent_known && p !== null && p !== r.agent_id && byId.has(p)) {
      const list = kids.get(p) ?? [];
      list.push(r);
      kids.set(p, list);
    } else {
      roots.push({ row: r, unlinked: !(r.parent_known && p === null) });
    }
  }
  const seen = new Set<string>();
  const grow = (row: SubagentSnapshot, unlinked: boolean, depth: number): AgentNode => {
    seen.add(row.agent_id);
    const children: AgentNode[] = [];
    if (depth < MAX_AGENT_DEPTH) {
      for (const c of kids.get(row.agent_id) ?? []) {
        if (!seen.has(c.agent_id)) children.push(grow(c, false, depth + 1));
      }
    }
    return { row, children, unlinked, depth };
  };
  const out = roots.map((r) => grow(r.row, r.unlinked, 0));
  for (const r of byId.values()) if (!seen.has(r.agent_id)) out.push(grow(r, true, 0));
  return out;
}

/** Ids of every node that has children. */
export function expandableIds(nodes: readonly AgentNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly AgentNode[]) => {
    for (const n of list) {
      if (n.children.length > 0) ids.push(n.row.agent_id);
      walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}
