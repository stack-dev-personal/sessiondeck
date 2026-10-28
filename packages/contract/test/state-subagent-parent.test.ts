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
    expect(s.tracking.pending_tainted).toBeUndefined();
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

  it("a failed Agent call with one pending context drops one entry and stays known", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = spawn(spawn(s, "A"), "A");
    s = failAgent(s, "A");
    expect(s.tracking.pending_spawns).toEqual(["A"]);
    expect(s.tracking.pending_tainted).toBeUndefined();
    s = start(s, "C");
    expect(row(s, "C")).toMatchObject({ parent_agent_id: "A", parent_known: true });
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
    expect(s.tracking.pending_tainted).toBe(true);
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

  it("readTracking shortens stored pending ids and keeps the taint flag only when true", () => {
    const t2 = readTracking({ pending_spawns: ["p".repeat(500), null], pending_tainted: true });
    expect(t2.pending_spawns?.[0]).toHaveLength(AGENT_ID_MAX_CHARS);
    expect(t2.pending_tainted).toBe(true);
    expect(
      readTracking({ pending_spawns: [null], pending_tainted: 1 }).pending_tainted,
    ).toBeUndefined();
    expect(readTracking({ pending_tainted: true }).pending_tainted).toBeUndefined();
  });
});

describe("window rule (conservative parent attribution)", () => {
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
  const unlinked = { parent_agent_id: null, parent_known: false };

  it("reviewer case: rows A and B, spawn(null), spawn(A), s1, spawn(B), s2, s3: none known", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = start(spawn(s, "A"), "B");
    s = spawn(spawn(s, null), "A");
    s = start(s, "s1");
    s = spawn(s, "B");
    s = start(start(s, "s2"), "s3");
    for (const id of ["s1", "s2", "s3"]) expect(row(s, id)).toMatchObject(unlinked);
    expect(s.tracking.pending_spawns).toBeUndefined();
    expect(s.tracking.pending_tainted).toBeUndefined();
  });

  it("an early known start stays right when a different context spawns later", () => {
    // spawn(null) x2, s1 consumes null (all queued so far are main): known null is causally right.
    let s = start(spawn(snap("working"), null), "A");
    s = start(spawn(spawn(s, null), null), "s1");
    expect(row(s, "s1")).toMatchObject({ parent_agent_id: null, parent_known: true });
    s = spawn(s, "A"); // mixes now
    expect(s.tracking.pending_tainted).toBe(true);
    s = start(start(s, "s2"), "s3");
    expect(row(s, "s2")).toMatchObject(unlinked);
    expect(row(s, "s3")).toMatchObject(unlinked);
  });

  it("single context parallel: main spawns 3, one fails, both starts are known null", () => {
    let s = spawn(spawn(spawn(snap("working"), null), null), null);
    s = failAgent(s, null);
    s = start(start(s, "P"), "Q");
    expect(row(s, "P")).toMatchObject({ parent_agent_id: null, parent_known: true });
    expect(row(s, "Q")).toMatchObject({ parent_agent_id: null, parent_known: true });
  });

  it("mixed failure: pending [null, A] then failure: all starts until empty are unlinked", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = spawn(spawn(s, null), "A");
    // taint already set by the mix; the failure keeps the list and the taint
    s = failAgent(s, null);
    expect(s.tracking.pending_spawns).toEqual([null, "A"]);
    s = start(start(s, "X"), "Y");
    expect(row(s, "X")).toMatchObject(unlinked);
    expect(row(s, "Y")).toMatchObject(unlinked);
    expect(s.tracking.pending_tainted).toBeUndefined();
  });

  it("a taint survives a failure that leaves one context pending", () => {
    let s = start(spawn(snap("working"), null), "A");
    s = spawn(spawn(spawn(s, null), "A"), "A");
    s = start(s, "X"); // pending [A, A], tainted
    s = failAgent(s, "A");
    s = start(s, "Y");
    expect(row(s, "Y")).toMatchObject(unlinked);
  });

  it("cap drop taints the window; a fresh single-context window is known again", () => {
    let s = snap("working");
    for (let i = 0; i < PENDING_SPAWNS_MAX + 1; i += 1) s = spawn(s, null);
    for (let i = 0; i < PENDING_SPAWNS_MAX; i += 1) {
      s = start(s, `K${i}`);
      expect(row(s, `K${i}`)).toMatchObject(unlinked);
    }
    expect(s.tracking.pending_spawns).toBeUndefined();
    expect(s.tracking.pending_tainted).toBeUndefined();
    s = start(spawn(s, null), "FRESH");
    expect(row(s, "FRESH")).toMatchObject({ parent_agent_id: null, parent_known: true });
  });

  it("a new prompt ends the window and clears the taint", () => {
    let s = spawn(spawn(snap("working"), null), "A");
    s = reduce(s, hook("UserPromptSubmit", {}));
    expect(s.tracking.pending_tainted).toBeUndefined();
    s = start(spawn(s, null), "N");
    expect(row(s, "N")).toMatchObject({ parent_agent_id: null, parent_known: true });
  });

  it("a taint survives a transition", () => {
    const s = reduce(spawn(spawn(snap("working"), null), "A"), hook("Stop", {}));
    expect(s.tracking.pending_tainted).toBe(true);
  });

  /*
   * Ground-truth fuzz. Model: spawns are issued in order by random contexts; each spawn either
   * fails or yields a start. The real start order is any interleaving that respects causality (a
   * start/failure comes after its spawn), and the real spawn-to-start mapping is arbitrary (not just
   * FIFO). Invariant: when the reducer marks a start known with parent P, P is the true parent under
   * EVERY mapping consistent with the events seen so far (causality only), i.e. the set of contexts
   * that were possible for that start is exactly {P}. We compute the possible set as all contexts of
   * spawns queued (issued and not yet resolved by the reducer's own count) at the start.
   */
  it("fuzz: parent_known true implies the parent is the only causally possible one", () => {
    let seed = 20_261_028;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % n;
    };
    const ctxs: (string | null)[] = [null, "A", "B"];
    let knownCount = 0;
    const t0 = Date.now();
    for (let run = 0; run < 2_000; run += 1) {
      const mk = (id: string) => ({
        agent_id: id,
        agent_type: "t",
        started_at: 1,
        ended_at: null,
        tokens: null,
        context_window: null,
        model: null,
        parent_agent_id: null,
        parent_known: true,
      });
      let s = snap("working", { subagents: [mk("A"), mk("B")] });
      // truth: unresolved spawns with their contexts (multiset); every start picks one at random.
      const open: (string | null)[] = [];
      let n = 0;
      const steps = 4 + rnd(16);
      for (let i = 0; i < steps; i += 1) {
        const op = rnd(10);
        if (op < 5 || open.length === 0) {
          const c = ctxs[rnd(ctxs.length)] ?? null;
          open.push(c);
          s = spawn(s, c);
        } else if (op < 8) {
          const k = rnd(open.length);
          const truth = open.splice(k, 1)[0] ?? null;
          const id = `r${run}-${n++}`;
          s = start(s, id);
          const r = row(s, id);
          if (r?.parent_known === true) {
            knownCount += 1;
            // possible parents: every context of a spawn that was unresolved when the start came
            const possible = new Set(open.concat([truth]));
            expect(possible.size).toBe(1);
            expect(r.parent_agent_id).toBe(truth);
          }
        } else {
          const k = rnd(open.length);
          open.splice(k, 1);
          s = failAgent(s, ctxs[rnd(ctxs.length)] ?? null);
        }
      }
    }
    expect(knownCount).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(2_000);
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

  it("readSubagentRows normalizes only the last SUBAGENT_ROWS_MAX of 5,000 rows, fast", () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      ...base,
      agent_id: `r${i}`,
      parent_agent_id: i === 0 ? null : `r${i - 1}`,
      parent_known: true,
    }));
    const t0 = Date.now();
    const rows = readSubagentRows(many);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(rows).toHaveLength(SUBAGENT_ROWS_MAX);
    expect(rows[0]?.agent_id).toBe(`r${5_000 - SUBAGENT_ROWS_MAX}`);
    // the first kept row's parent was cut off, so it reads unknown; the rest keep their links
    expect(rows[0]).toMatchObject({ parent_agent_id: null, parent_known: false });
    expect(rows[1]).toMatchObject({ parent_known: true });
  });
});
