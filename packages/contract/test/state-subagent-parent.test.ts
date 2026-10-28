/*
 * R3.11 (data side): parent links for subagent rows. The fixtures hold one main-thread
 * PreToolUse(Agent) (PreToolUse/21-agent.json, no agent_id) and one SubagentStart
 * (SubagentStart/01-subagent.json). No captured session shows a subagent spawning a subagent, so the
 * nested cases below are SYNTHETIC: fixture payloads with an envelope agent_id added. PROVISIONAL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ID_MAX_CHARS, PENDING_SPAWNS_MAX, SUBAGENT_ROWS_MAX } from "../src/limits";
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
    const s = start(reduce(start(spawn(snap("working"), null), "A"), e), "B");
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

  it("after an ambiguous start, the next start of the leftover set is also unknown", () => {
    // main spawns, then background A spawns; A's child B starts first, then main's child C.
    let s = spawn(spawn(snap("working"), null), "A");
    s = start(start(s, "B"), "C");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(row(s, "C")).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(s.tracking.pending_spawns).toBeUndefined();
    expect(s.tracking.ambiguous_remaining).toBeUndefined();
  });

  it("a spawn made after the ambiguous set starts clean once the set is drained", () => {
    let s = spawn(spawn(snap("working"), null), "A");
    s = start(start(s, "B"), "C");
    s = start(spawn(s, null), "D");
    expect(row(s, "D")).toMatchObject({ parent_agent_id: null, parent_known: true });
  });

  it("a parent that is not an existing row is recorded as null / unknown", () => {
    const s = start(spawn(snap("working"), "GHOST"), "B");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: null, parent_known: false });
  });

  it("parent loops cannot form: A>B then B>A leaves the second link unknown", () => {
    let s = start(spawn(snap("working"), "B"), "A"); // B is not a row yet: A unlinked
    s = start(spawn(s, "A"), "B"); // A is a row: B parent A
    expect(row(s, "A")).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(row(s, "B")).toMatchObject({ parent_agent_id: "A", parent_known: true });
    // no cycle: walking up from B ends
    expect(row(s, "A")?.parent_agent_id).toBeNull();
  });

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
  const stop = (s: SessionSnapshot, id: string): SessionSnapshot =>
    reduce(s, hook("SubagentStop", { agent_id: id }, (t += 1), { agent_id: id }));

  it("a failed Agent call keeps pending entries and marks the whole list unknown", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = spawn(s, "A");
    s = failAgent(s, "A");
    expect(s.tracking.pending_spawns).toEqual(["A"]);
    expect(s.tracking.ambiguous_remaining).toBe(1);
    s = start(s, "C");
    expect(row(s, "C")).toMatchObject({ parent_agent_id: null, parent_known: false });
  });

  it("MAJOR: failure of an already-started spawn does not make a later start wrongly known", () => {
    let s = start(spawn(snap("working"), null), "A"); // row A exists
    s = spawn(s, null); // X
    s = start(s, "X"); // X started, pending empty
    s = spawn(s, null); // Y: [null]
    s = spawn(s, "A"); // Z by A: [null, "A"]
    s = failAgent(s, "X"); // X's own Agent call fails
    expect(s.tracking.pending_spawns).toEqual([null, "A"]);
    s = start(s, "Y");
    expect(row(s, "Y")).toMatchObject({ parent_agent_id: null, parent_known: false });
    s = start(s, "Z");
    expect(row(s, "Z")).toMatchObject({ parent_agent_id: null, parent_known: false });
  });

  it("MINOR: the 16-entry cap dropping entries marks the kept list unknown", () => {
    let s = start(spawn(snap("working"), null), "A0");
    s = spawn(s, "A0");
    for (let i = 0; i < PENDING_SPAWNS_MAX; i += 1) s = spawn(s, null);
    expect(s.tracking.pending_spawns).toHaveLength(PENDING_SPAWNS_MAX);
    expect(s.tracking.ambiguous_remaining).toBe(PENDING_SPAWNS_MAX);
    s = start(s, "K");
    expect(row(s, "K")).toMatchObject({ parent_agent_id: null, parent_known: false });
  });

  it("SECURITY: evicting a parent row clears child links; a reused id cannot form a loop", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = start(spawn(s, "A"), "B");
    s = stop(s, "A");
    for (let i = 0; i < SUBAGENT_ROWS_MAX - 1; i += 1) {
      s = stop(start(spawn(s, null), `F${i}`), `F${i}`);
    }
    expect(row(s, "A")).toBeUndefined();
    expect(row(s, "B")).toMatchObject({ parent_agent_id: null, parent_known: false });
    s = start(spawn(s, "B"), "A");
    expect(row(s, "B")).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(row(s, "A")).toMatchObject({ parent_agent_id: "B", parent_known: true });
    // no cycle anywhere: every walk up ends
    for (const r of s.subagents) {
      let cur: string | null = r.agent_id;
      for (let hops = 0; cur !== null; hops += 1) {
        expect(hops).toBeLessThanOrEqual(SUBAGENT_ROWS_MAX);
        cur = row(s, cur)?.parent_agent_id ?? null;
      }
    }
  });

  it("a failed non-spawn tool leaves pending spawns alone", () => {
    const s = reduce(
      spawn(snap("working"), null),
      hook("PostToolUseFailure", { tool_name: "Bash" }, (t += 1)),
    );
    expect(s.tracking.pending_spawns).toEqual([null]);
  });

  it("parallel spawns from one context are all known", () => {
    let s = spawn(spawn(start(spawn(snap("working"), null), "A"), "A"), "A");
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

  it("readSubagentRow tolerates null and non-objects, and shortens long parent ids", () => {
    expect(readSubagentRow(null)).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(readSubagentRow("x")).toMatchObject({ parent_agent_id: null, parent_known: false });
    const long = readSubagentRow({
      agent_id: "A",
      parent_agent_id: "p".repeat(500),
      parent_known: true,
    });
    expect(long.parent_agent_id).toHaveLength(AGENT_ID_MAX_CHARS);
  });

  it("readTracking shortens stored pending ids and keeps ambiguous_remaining in range", () => {
    const t2 = readTracking({ pending_spawns: ["p".repeat(500), null], ambiguous_remaining: 9 });
    expect(t2.pending_spawns?.[0]).toHaveLength(AGENT_ID_MAX_CHARS);
    expect(t2.ambiguous_remaining).toBe(2);
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
});
