// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "@sessiondeck/contract";
import { buildAgentTree, expandableIds, MAX_AGENT_DEPTH } from "./agent-tree";

const row = (id: string, parent: string | null, known: boolean): SubagentSnapshot => ({
  agent_id: id,
  agent_type: "general-purpose",
  started_at: 1,
  ended_at: null,
  tokens: null,
  context_window: null,
  model: null,
  parent_agent_id: parent,
  parent_known: known,
});

describe("buildAgentTree", () => {
  it("nests three levels from linked rows", () => {
    const t = buildAgentTree([row("a", null, true), row("b", "a", true), row("c", "b", true)]);
    expect(t).toHaveLength(1);
    expect(t[0]!.unlinked).toBe(false);
    expect(t[0]!.children[0]!.children[0]!.row.agent_id).toBe("c");
    expect(expandableIds(t)).toEqual(["a", "b"]);
  });
  it("puts unknown-parent rows at the first level, unlinked", () => {
    const t = buildAgentTree([row("a", null, false), row("b", null, false)]);
    expect(t.map((n) => [n.row.agent_id, n.unlinked])).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });
  it("treats a missing parent as unlinked first level", () => {
    const t = buildAgentTree([row("a", "ghost", true)]);
    expect(t[0]!.unlinked).toBe(true);
  });
  it("survives cycles and self links", () => {
    const t = buildAgentTree([row("a", "b", true), row("b", "a", true), row("s", "s", true)]);
    const all: string[] = [];
    const walk = (n: typeof t) => n.forEach((x) => (all.push(x.row.agent_id), walk(x.children)));
    walk(t);
    expect(all.sort()).toEqual(["a", "b", "s"]);
  });
  it("caps depth", () => {
    const rows = [row("n0", null, true)];
    for (let i = 1; i < 200; i += 1) rows.push(row(`n${i}`, `n${i - 1}`, true));
    let d = 0;
    let n = buildAgentTree(rows)[0]!;
    while (n.children[0]) {
      n = n.children[0];
      d += 1;
    }
    expect(d).toBe(MAX_AGENT_DEPTH);
  });
});
