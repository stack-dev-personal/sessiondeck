/*
 * R0.2: the golden timeline. The payloads are one real session (fixtures/sessions/golden-session.jsonl,
 * 295 hook events, captured 2026-10-15). The expected timeline is a reviewable file next to it
 * (golden-session.timeline.json, explained in golden-session.timeline.md); each state change in it
 * was checked by hand against the transition table and names the table row that justifies it.
 * Nothing here is generated from reduce().
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../src/snapshot";
import { reduce, TRANSITIONS } from "../src/state";
import { rowState } from "../src/transitions";
import { BASE_TS, hookEnvelope, snapshotFor, tsOfEvent } from "./golden-helpers";
import type { LoadedFixture } from "./helpers";
import { FIXTURES_DIR, loadGoldenSession } from "./helpers";
import { deepFreeze } from "./state-helpers";

interface ExpectedChange {
  index: number;
  event: string;
  context: "main" | "subagent";
  from: string;
  to: string;
  state_detail: string | null;
  /** 1-based position of the justifying row in TRANSITIONS. */
  row: number;
}

interface ExpectedTimeline {
  events: number;
  changes: ExpectedChange[];
  final: {
    state: string;
    state_since_index: number;
    state_detail: string | null;
    ended_reason: string | null;
    last_event_index: number;
    compactions: number;
    tasks: SessionSnapshot["tasks"];
    model_id: string | null;
    tracking: SessionSnapshot["tracking"];
    subagents: { agent_type: string; started_index: number; ended_index: number | null }[];
  };
}

const golden: LoadedFixture[] = loadGoldenSession();
const expected = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "sessions", "golden-session.timeline.json"), "utf8"),
) as ExpectedTimeline;

const indexOfTs = (ts: number | null): number | null =>
  ts === null ? null : (ts - BASE_TS) / 1_000 - 1;

interface Step {
  index: number;
  fx: LoadedFixture;
  before: SessionSnapshot;
  after: SessionSnapshot;
}

function replayAll(freeze: boolean): Step[] {
  let current = snapshotFor(golden[0] as LoadedFixture);
  if (freeze) deepFreeze(current);
  return golden.map((fx, index) => {
    const env = hookEnvelope(fx, index);
    if (freeze) deepFreeze(env);
    const before = current;
    current = reduce(before, env);
    if (freeze) deepFreeze(current);
    return { index, fx, before, after: current };
  });
}

const steps = replayAll(false);
const last = (): SessionSnapshot => (steps[steps.length - 1] as Step).after;

describe("golden session: the full timeline (R0.2)", () => {
  it("has the 295 events the timeline file was written for", () => {
    expect(golden).toHaveLength(expected.events);
  });

  it("produces exactly the hand-verified state changes", () => {
    const actual = steps
      .filter((s) => s.after.state !== s.before.state)
      .map((s) => ({
        index: s.index,
        event: s.fx.dir,
        context:
          (s.fx.payload as { agent_id?: unknown }).agent_id === undefined ? "main" : "subagent",
        from: s.before.state,
        to: s.after.state,
        state_detail: s.after.state_detail,
      }));
    expect(actual).toEqual(
      expected.changes.map((c) => ({
        index: c.index,
        event: c.event,
        context: c.context,
        from: c.from,
        to: c.to,
        state_detail: c.state_detail,
      })),
    );
  });

  it("every recorded change names the transition row that fires it", () => {
    for (const c of expected.changes) {
      const row = TRANSITIONS[c.row - 1];
      expect(row, `row ${c.row}`).toBeDefined();
      expect(row?.trigger, `event ${c.index}`).toBe(c.event);
      expect(row?.to, `event ${c.index}`).toBe(c.to);
      const before = (steps[c.index] as Step).before;
      expect(row?.from, `event ${c.index}`).toContain(rowState(before));
    }
  });

  it("ends in the hand-verified final snapshot", () => {
    const f = last();
    expect({
      state: f.state,
      state_since_index: indexOfTs(f.state_since),
      state_detail: f.state_detail,
      ended_reason: f.ended_reason,
      last_event_index: indexOfTs(f.last_event_at),
      compactions: f.compactions,
      tasks: f.tasks,
      model_id: f.model?.id ?? null,
      tracking: f.tracking,
      subagents: f.subagents.map((a) => ({
        agent_type: a.agent_type,
        started_index: indexOfTs(a.started_at),
        ended_index: indexOfTs(a.ended_at),
      })),
    }).toEqual(expected.final);
  });

  it("keeps the bookkeeping invariants after every event", () => {
    for (const s of steps) {
      const a = s.after;
      const label = `event ${s.index} ${s.fx.dir}`;
      expect(a.last_event_at, label).toBe(tsOfEvent(s.index));
      expect(a.state_since === s.before.state_since || a.state !== s.before.state, label).toBe(
        true,
      );
      expect(a.tracking.permission !== null, label).toBe(a.state === "waiting_permission");
      expect(a.compactions, label).toBeGreaterThanOrEqual(0);
      expect(a.tasks.total, label).toBeGreaterThanOrEqual(a.tasks.completed);
      for (const row of a.subagents) {
        expect(row.ended_at === null || row.ended_at >= row.started_at, label).toBe(true);
      }
    }
  });

  it("events 217 and 229 (subagent PreToolUse over idle) change nothing but last_event_at", () => {
    for (const i of [217, 229]) {
      const s = steps[i] as Step;
      expect(s.fx.dir, `event ${i}`).toBe("PreToolUse");
      expect((s.fx.payload as { agent_id?: unknown }).agent_id, `event ${i}`).toBeDefined();
      expect(s.before.state, `event ${i}`).toBe("idle");
      expect(s.after, `event ${i}`).toEqual({ ...s.before, last_event_at: tsOfEvent(i) });
    }
  });

  it("no subagent event leaves idle or waiting_input", () => {
    for (const s of steps) {
      const fromSubagent = (s.fx.payload as { agent_id?: unknown }).agent_id !== undefined;
      if (fromSubagent && ["idle", "waiting_input"].includes(s.before.state)) {
        expect(s.after.state, `event ${s.index}`).toBe(s.before.state);
      }
    }
  });

  it("never leaves the main-thread-only states from a subagent event", () => {
    for (const s of steps) {
      const fromSubagent = (s.fx.payload as { agent_id?: unknown }).agent_id !== undefined;
      if (fromSubagent && s.after.state !== s.before.state) {
        expect(["working", "waiting_permission"], `event ${s.index}`).toContain(s.after.state);
      }
    }
  });
});

describe("golden session: SubagentStop without a SubagentStart", () => {
  const starts = new Set(
    golden
      .filter((f) => f.dir === "SubagentStart")
      .map((f) => (f.payload as { agent_id: string }).agent_id),
  );
  const stops = steps.filter((s) => s.fx.dir === "SubagentStop");
  const orphans = stops.filter((s) => !starts.has((s.fx.payload as { agent_id: string }).agent_id));

  it("the capture has 10 SubagentStop events and 9 of them have no matching SubagentStart", () => {
    expect(stops).toHaveLength(10);
    expect(orphans).toHaveLength(9);
    expect(orphans.every((s) => (s.fx.payload as { agent_type: string }).agent_type === "")).toBe(
      true,
    );
  });

  it("an orphan SubagentStop changes nothing but last_event_at, and no state", () => {
    for (const s of orphans) {
      expect(s.after, `event ${s.index}`).toEqual({
        ...s.before,
        last_event_at: tsOfEvent(s.index),
      });
    }
  });

  it("the one matched SubagentStop closes the one row, and no counter goes negative", () => {
    const f = last();
    expect(f.subagents).toHaveLength(1);
    expect(f.subagents[0]?.ended_at).not.toBeNull();
    expect([f.compactions, f.tasks.total, f.tasks.completed].every((n) => n >= 0)).toBe(true);
  });
});

describe("golden session: purity", () => {
  it("same input twice gives deep-equal output", () => {
    const again = replayAll(false);
    expect(again.map((s) => s.after)).toEqual(steps.map((s) => s.after));
  });

  it("deep-frozen inputs are neither mutated nor rejected, and the result is unchanged", () => {
    const frozen = replayAll(true);
    expect(frozen.map((s) => s.after)).toEqual(steps.map((s) => s.after));
    expect((frozen[frozen.length - 1] as Step).after.state).toBe("ended");
  });
});
