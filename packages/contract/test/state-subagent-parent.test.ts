/*
 * R3.11 (data side), option B: rows built from hook envelopes are always unlinked (parent null,
 * parent_known false). Real links arrive with S7 transcript attachment; stored rows carrying valid
 * links (as S7 would write) are still read and normalized. Hook sequences use fixture payloads
 * (PreToolUse/21-agent.json, SubagentStart/01-subagent.json) with an envelope agent_id added for
 * nested contexts, which is SYNTHETIC: no capture shows a subagent spawning a subagent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ID_MAX_CHARS, SUBAGENT_ROWS_MAX } from "../src/limits";
import { readTracking } from "../src/tracking";
import { reduce } from "../src/state";
import type { SessionSnapshot } from "../src/snapshot";
import { readSubagentRow, readSubagentRows } from "../src/snapshot";
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
const stop = (s: SessionSnapshot, id: string): SessionSnapshot =>
  reduce(s, hook("SubagentStop", { agent_id: id }, (t += 1), { agent_id: id }));
const failAgent = (s: SessionSnapshot, by: string | null): SessionSnapshot =>
  reduce(
    s,
    hook(
      "PostToolUseFailure",
      { ...agentPre, hook_event_name: "PostToolUseFailure" },
      (t += 1),
      by === null ? {} : { agent_id: by },
    ),
  );
const prompt = (s: SessionSnapshot): SessionSnapshot => reduce(s, hook("UserPromptSubmit", {}));
const row = (s: SessionSnapshot, id: string) => s.subagents.find((a) => a.agent_id === id);
const unlinked = { parent_agent_id: null, parent_known: false };
const allUnlinked = (s: SessionSnapshot): void => {
  for (const r of s.subagents) expect(r).toMatchObject(unlinked);
};

describe("hook-built subagent rows are unlinked (option B)", () => {
  it("the fixture PreToolUse(Agent) carries no agent_id and SubagentStart names the new agent", () => {
    expect(agentPre["tool_name"]).toBe("Agent");
    expect(agentPre["agent_id"]).toBeUndefined();
    expect(startFx["agent_id"]).toBe("750bc48c804160940");
  });

  it("the real fixture shapes give an unlinked row", () => {
    const e1 = hook("PreToolUse", agentPre, 5_000);
    const e2 = hook("SubagentStart", startFx, 5_001, { agent_id: "750bc48c804160940" });
    const next = reduce(reduce(snap("working"), e1), e2);
    expect(next.subagents).toHaveLength(1);
    allUnlinked(next);
  });

  it("start with and without a spawn: unlinked", () => {
    allUnlinked(start(spawn(snap("working"), null), "A"));
    allUnlinked(start(snap("working"), "A"));
  });

  it("nested subagent contexts: unlinked", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = start(spawn(s, "A"), "B");
    s = start(spawn(s, "B"), "C");
    expect(s.subagents).toHaveLength(3);
    allUnlinked(s);
  });

  it("reviewer sequence 1: failure after start, then a start", () => {
    let s = spawn(snap("working"), "A");
    s = start(s, "X");
    s = spawn(s, "A"); // Y
    s = failAgent(s, "A"); // X fails after start
    s = spawn(s, "B"); // Z
    s = start(s, "Y");
    expect(row(s, "Y")).toMatchObject(unlinked);
    allUnlinked(s);
  });

  it("reviewer sequence 2: cap drop then another context", () => {
    let s = snap("working");
    for (let i = 0; i < 17; i += 1) s = spawn(s, "A");
    for (let i = 0; i < 16; i += 1) s = start(s, `K${i}`);
    s = spawn(s, "B");
    s = start(s, "last");
    expect(row(s, "last")).toMatchObject(unlinked);
    allUnlinked(s);
  });

  it("reviewer sequence 3: a prompt between spawns", () => {
    let s = spawn(snap("working"), "A");
    s = prompt(s);
    s = spawn(s, "B");
    s = start(s, "late");
    expect(row(s, "late")).toMatchObject(unlinked);
    allUnlinked(s);
  });

  it("failures, prompts, Task tool name, transitions: unlinked, state untouched by spawns", () => {
    const task = hook("PreToolUse", { ...agentPre, tool_name: "Task" }, (t += 1), {
      agent_id: "A",
    });
    let s = spawn(snap("working"), null);
    expect(s.state).toBe("working");
    expect(s.tracking).toEqual({ last_tool: "Agent", permission: null });
    s = start(reduce(s, task), "A");
    s = failAgent(s, null);
    s = prompt(s);
    s = start(reduce(s, hook("Stop", {})), "B");
    allUnlinked(s);
  });

  it("many ids: the 50-row cap keeps every row unlinked", () => {
    let s = snap("working");
    for (let i = 0; i < SUBAGENT_ROWS_MAX + 5; i += 1)
      s = stop(start(spawn(s, "A"), `F${i}`), `F${i}`);
    expect(s.subagents).toHaveLength(SUBAGENT_ROWS_MAX);
    allUnlinked(s);
  });

  it("a duplicate SubagentStart changes nothing; agent_id is capped", () => {
    const s = start(snap("working"), "A");
    expect(start(s, "A").subagents).toHaveLength(1);
    const long = "z".repeat(AGENT_ID_MAX_CHARS + 30);
    expect(start(snap("working"), long).subagents[0]?.agent_id).toHaveLength(AGENT_ID_MAX_CHARS);
  });

  it("a stored row without the parent fields still reduces", () => {
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
});

describe("old stored tracking", () => {
  it("pending_spawns / pending_tainted / ambiguous_remaining are ignored, never thrown on", () => {
    const stored = {
      last_tool: "Bash",
      permission: null,
      pending_spawns: [1, "A", null, {}, "p".repeat(500)],
      pending_tainted: true,
      ambiguous_remaining: 3,
    };
    expect(readTracking(stored)).toEqual({ last_tool: "Bash", permission: null });
    expect(readTracking({ pending_spawns: "x", pending_tainted: 1 })).toEqual({
      last_tool: null,
      permission: null,
    });
  });

  it("reduce on a snapshot carrying them returns clean tracking and unlinked starts", () => {
    const old = snap("working");
    const prev = {
      ...old,
      tracking: { ...old.tracking, pending_spawns: ["A", null], pending_tainted: true },
    } as SessionSnapshot;
    const next = start(reduce(prev, hook("Stop", {})), "S");
    expect(next.tracking).toEqual({ last_tool: null, permission: null });
    allUnlinked(next);
  });
});

describe("stored links (as S7 would write them)", () => {
  const stored = (id: string, p: string | null, known: boolean) => ({
    agent_id: id,
    agent_type: "t",
    started_at: 1,
    ended_at: null,
    tokens: null,
    context_window: null,
    model: null,
    parent_agent_id: p,
    parent_known: known,
  });

  it("valid links survive a reduce, readSubagentRow keeps them, and new starts stay unlinked", () => {
    const prev = snap("working", {
      subagents: [stored("P", null, true), stored("C", "P", true)] as never,
    });
    const next = start(reduce(prev, hook("Stop", {})), "N");
    expect(row(next, "C")).toMatchObject({ parent_agent_id: "P", parent_known: true });
    expect(row(next, "P")).toMatchObject({ parent_agent_id: null, parent_known: true });
    expect(row(next, "N")).toMatchObject(unlinked);
    expect(readSubagentRow(stored("C", "P", true))).toMatchObject({
      parent_agent_id: "P",
      parent_known: true,
    });
  });

  it("evicting a parent row by the cap clears the child link", () => {
    let s = snap("working", {
      subagents: [{ ...stored("P", null, true), ended_at: 2 }, stored("C", "P", true)] as never,
    });
    for (let i = 0; i < SUBAGENT_ROWS_MAX - 1; i += 1) s = start(s, `F${i}`);
    expect(row(s, "P")).toBeUndefined();
    expect(row(s, "C")).toMatchObject(unlinked);
  });
});

describe("stored subagent rows", () => {
  const base = { agent_type: "t", started_at: 1, ended_at: null, tokens: null };

  it("MINOR: readSubagentRow does not keep parent_known for a non-string parent", () => {
    const r = readSubagentRow({ agent_id: "b", parent_agent_id: 5, parent_known: true });
    expect(r).toMatchObject({ parent_agent_id: null, parent_known: false });
  });

  it("readSubagentRows drops [], {}, null, 7 and non-array input", () => {
    const good = { ...base, agent_id: "a" };
    expect(readSubagentRows([[], {}, null, 7, good]).map((r) => r.agent_id)).toEqual(["a"]);
    expect(readSubagentRows(null)).toEqual([]);
    expect(readSubagentRows({ 0: good })).toEqual([]);
    expect(readSubagentRows("x")).toEqual([]);
  });

  it("readSubagentRows clears links to missing parents and on cycles, keeps good links", () => {
    const link = (id: string, p: string | null, known = true) => ({
      ...base,
      agent_id: id,
      parent_agent_id: p,
      parent_known: known,
    });
    const rows = readSubagentRows([
      link("a", "b"),
      link("b", "a"),
      link("c", "a"),
      link("d", "ghost"),
      link("e", "e"),
      link("f", null),
      link("g", "f"),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
    for (const id of ["a", "b", "d", "e"]) {
      expect(by[id]).toMatchObject({ parent_agent_id: null, parent_known: false });
    }
    expect(by["c"]).toMatchObject({ parent_agent_id: "a", parent_known: true });
    expect(by["f"]).toMatchObject({ parent_agent_id: null, parent_known: true });
    expect(by["g"]).toMatchObject({ parent_agent_id: "f", parent_known: true });
  });

  it("readSubagentRows keeps the first of duplicate agent_ids", () => {
    const rows = readSubagentRows([
      { ...base, agent_id: "a", agent_type: "first" },
      { ...base, agent_id: "a", agent_type: "second" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_type).toBe("first");
  });

  it("readSubagentRows normalizes only the last SUBAGENT_ROWS_MAX of 5,000 rows", () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      ...base,
      agent_id: `r${i}`,
      parent_agent_id: i === 0 ? null : `r${i - 1}`,
      parent_known: true,
    }));
    const rows = readSubagentRows(many);
    expect(rows).toHaveLength(SUBAGENT_ROWS_MAX);
    expect(rows[0]?.agent_id).toBe(`r${5_000 - SUBAGENT_ROWS_MAX}`);
    // the first kept row's parent was cut off, so it reads unknown; the rest keep their links
    expect(rows[0]).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(rows[1]).toMatchObject({ parent_known: true });
  });

  it("readSubagentRows caps agent_id before dedupe", () => {
    const longA = "a".repeat(AGENT_ID_MAX_CHARS) + "X";
    const longB = "a".repeat(AGENT_ID_MAX_CHARS) + "Y";
    const rows = readSubagentRows([
      { ...base, agent_id: longA, agent_type: "first" },
      { ...base, agent_id: longB, agent_type: "second" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toHaveLength(AGENT_ID_MAX_CHARS);
    expect(rows[0]?.agent_type).toBe("first");
    expect(readSubagentRow({ agent_id: longA }).agent_id).toHaveLength(AGENT_ID_MAX_CHARS);
  });
});
