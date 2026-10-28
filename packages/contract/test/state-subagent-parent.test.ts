/*
 * R3.11 (data side): parent links for subagent rows. The fixtures hold one main-thread
 * PreToolUse(Agent) (PreToolUse/21-agent.json, no agent_id) and one SubagentStart
 * (SubagentStart/01-subagent.json). No captured session shows a subagent spawning a subagent, so the
 * nested cases below are SYNTHETIC: fixture payloads with an envelope agent_id added. PROVISIONAL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PENDING_SPAWNS_MAX } from "../src/limits";
import { readTracking } from "../src/tracking";
import { reduce } from "../src/state";
import type { SessionSnapshot } from "../src/snapshot";
import { readSubagentRow } from "../src/snapshot";
import { FIXTURES_DIR } from "./helpers";
import { hook, snap } from "./state-helpers";

const fx = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, path), "utf8")) as Record<string, unknown>;
const agentPre = fx("PreToolUse/21-agent.json");
const startFx = fx("SubagentStart/01-subagent.json");

let t = 10_000;
const spawn = (s: SessionSnapshot, by: string | null): SessionSnapshot =>
  reduce(s, hook("PreToolUse", agentPre, (t += 1), by === null ? {} : { agent_id: by }));
const start = (s: SessionSnapshot, id: string): SessionSnapshot =>
  reduce(s, hook("SubagentStart", { ...startFx, agent_id: id }, (t += 1), { agent_id: id }));
const row = (s: SessionSnapshot, id: string) => s.subagents.find((a) => a.agent_id === id);

describe("subagent parent links", () => {
  it("the fixture PreToolUse(Agent) carries no agent_id and SubagentStart names the new agent", () => {
    expect(agentPre["tool_name"]).toBe("Agent");
    expect(agentPre["agent_id"]).toBeUndefined();
    expect(startFx["agent_id"]).toBe("750bc48c804160940");
  });

  it("(a) main-thread spawn: parent null, known", () => {
    const next = start(spawn(snap("working"), null), "A");
    expect(row(next, "A")).toMatchObject({ parent_agent_id: null, parent_known: true });
    expect(next.tracking.pending_spawns).toBeUndefined();
  });

  it("(a2) the real fixture shapes give a known main-thread parent", () => {
    const e1 = hook("PreToolUse", agentPre, 5_000);
    const e2 = hook("SubagentStart", startFx, 5_001, { agent_id: "750bc48c804160940" });
    const next = reduce(reduce(snap("working"), e1), e2);
    expect(next.subagents[0]).toMatchObject({ parent_agent_id: null, parent_known: true });
  });

  it("(b) nested: B spawned from A", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = start(spawn(s, "A"), "B");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: "A", parent_known: true });
    expect(row(s, "A")).toMatchObject({ parent_agent_id: null, parent_known: true });
  });

  it("(c) three levels A > B > C", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = start(spawn(s, "A"), "B");
    s = start(spawn(s, "B"), "C");
    expect(row(s, "C")).toMatchObject({ parent_agent_id: "B", parent_known: true });
    expect(row(s, "B")?.parent_agent_id).toBe("A");
  });

  it("the Task tool name counts as a spawn too", () => {
    const e = hook("PreToolUse", { ...agentPre, tool_name: "Task" }, 5_000, { agent_id: "A" });
    const s = start(reduce(snap("working"), e), "B");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: "A", parent_known: true });
  });

  it("(d) SubagentStart without a pending spawn: parent unknown", () => {
    const s = start(snap("working"), "A");
    expect(row(s, "A")).toMatchObject({ parent_agent_id: null, parent_known: false });
  });

  it("spawns from two contexts at once are ambiguous: unknown, and still consumed", () => {
    let s = spawn(spawn(snap("working"), null), "A");
    s = start(s, "B");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(s.tracking.pending_spawns).toHaveLength(1);
  });

  it("parallel spawns from one context are all known", () => {
    let s = spawn(spawn(snap("working"), "A"), "A");
    s = start(start(s, "B"), "C");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: "A", parent_known: true });
    expect(row(s, "C")).toMatchObject({ parent_agent_id: "A", parent_known: true });
  });

  it("other tools record nothing; a new prompt clears stale spawns; state is untouched", () => {
    const bash = reduce(snap("working"), hook("PreToolUse", { tool_name: "Bash" }));
    expect(bash.tracking.pending_spawns).toBeUndefined();
    const s = spawn(snap("working"), null);
    expect(s.state).toBe("working");
    expect(reduce(s, hook("UserPromptSubmit", {})).tracking.pending_spawns).toBeUndefined();
  });

  it("pending spawns survive transitions and are capped", () => {
    let s = snap("working");
    for (let i = 0; i < PENDING_SPAWNS_MAX + 5; i++) s = spawn(s, null);
    expect(s.tracking.pending_spawns).toHaveLength(PENDING_SPAWNS_MAX);
    const stopped = reduce(s, hook("Stop", {}));
    expect(stopped.tracking.pending_spawns).toHaveLength(PENDING_SPAWNS_MAX);
  });

  it("readTracking tolerates a damaged pending list and snapshots without it", () => {
    expect(readTracking({ pending_spawns: [1, "A", null, {}] }).pending_spawns).toEqual([
      "A",
      null,
    ]);
    expect(readTracking({ pending_spawns: "x" })).toEqual({ last_tool: null, permission: null });
  });

  it("a stored row without the new fields still reduces", () => {
    const old = {
      agent_id: "A",
      agent_type: "t",
      started_at: 1,
      ended_at: null,
      tokens: null,
      context_window: null,
      model: null,
    };
    const prev = snap("working", { subagents: [old as never] });
    const next = reduce(prev, hook("SubagentStop", { agent_id: "A" }, 20_000));
    expect(next.subagents[0]?.ended_at).toBe(20_000);
  });

  it("readSubagentRow defaults old rows to null / false and keeps new ones", () => {
    const old = {
      agent_id: "A",
      agent_type: "t",
      started_at: 1,
      ended_at: null,
      tokens: null,
      context_window: null,
      model: null,
    };
    expect(readSubagentRow(old as never)).toMatchObject({
      parent_agent_id: null,
      parent_known: false,
    });
    const kept = readSubagentRow({ ...old, parent_agent_id: "P", parent_known: true });
    expect(kept).toMatchObject({ parent_agent_id: "P", parent_known: true });
  });
});
