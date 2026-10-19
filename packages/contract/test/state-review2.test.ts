/*
 * Review iteration 2 (R0.1, R0.2, R0.3, R0.5): unknown permission requester, waiting_input kept
 * against subagent tool events, stale detail text, caps, totality on damaged tracking.
 * Every payload is SYNTHETIC (documented fields only).
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_ID_MAX_CHARS,
  AGENT_TYPE_MAX_CHARS,
  END_REASON_MAX_CHARS,
  MODEL_ID_MAX_CHARS,
  SUBAGENT_ROWS_MAX,
  TRUNCATION_MARKER,
} from "../src/limits";
import type { SessionSnapshot, SubagentSnapshot } from "../src/snapshot";
import { createTracking } from "../src/snapshot";
import type { SessionState } from "../src/state";
import {
  HOOK_EVENTS,
  SESSION_STATES,
  reduce,
  reduceLiveness,
  supersedeSamePid,
} from "../src/state";
import { readTracking } from "../src/tracking";
import { HOST, T0, hook, liveness, snap } from "./state-helpers";

const SUB = { agent_id: "agent-1" };
const OTHER = { agent_id: "agent-2" };
const text = (n: number): string => "x".repeat(n);

function run(
  start: SessionSnapshot,
  steps: readonly [string, unknown?, { agent_id: string }?][],
): SessionSnapshot {
  return steps.reduce(
    (s, [name, payload, extra], i) => reduce(s, hook(name, payload ?? {}, T0 + 10 + i, extra)),
    start,
  );
}

describe("finding 1: a Notification without agent_id leaves the requester unknown", () => {
  const prompt = { notification_type: "permission_prompt" };

  it("subagent PreToolUse, bare Notification, subagent PostToolUse: back to working", () => {
    const mid = run(snap("working"), [
      ["PreToolUse", { tool_name: "Bash" }, SUB],
      ["Notification", prompt],
    ]);
    expect(mid.state).toBe("waiting_permission");
    expect(mid.tracking.permission).toEqual({ tool: null, requester_unknown: true });
    const after = run(mid, [["PostToolUse", {}, SUB]]);
    expect(after.state).toBe("working");
    expect(after.tracking.permission).toBeNull();
    expect(run(after, [["PreToolUse", { tool_name: "Read" }, SUB]]).state).toBe("working");
  });

  it.each(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"])(
    "%s from the main thread or any subagent leaves an unknown-requester prompt",
    (name) => {
      const asked = reduce(snap("working"), hook("Notification", prompt));
      for (const extra of [undefined, SUB, OTHER]) {
        expect(reduce(asked, hook(name, {}, 9_000, extra)).state).toBe("working");
      }
    },
  );

  it("a Notification that carries an agent_id still scopes the prompt to that agent", () => {
    const scoped = reduce(snap("working"), hook("Notification", prompt, T0 + 1, SUB));
    expect(scoped.tracking.permission).toEqual({ tool: null, agent_id: "agent-1" });
    expect(reduce(scoped, hook("PostToolUse")).state).toBe("waiting_permission");
    expect(reduce(scoped, hook("PostToolUse", {}, 9_000, OTHER)).state).toBe("waiting_permission");
    expect(reduce(scoped, hook("PostToolUse", {}, 9_000, SUB)).state).toBe("working");
  });
});

describe("finding 2: keep rows do not carry text that described the previous state", () => {
  it("alive:false then PostToolUse is working without 'process gone'", () => {
    const dead = reduceLiveness(snap("working", { pid: 5 }), liveness({ pid: 5, alive: false }));
    expect(dead.state_detail).toBe("process gone");
    expect(reduce(dead, hook("PostToolUse")).state_detail).toBeNull();
  });

  it("superseded then PostToolUse is working without 'superseded'", () => {
    const [gone] = supersedeSamePid([snap("working", { pid: 5 })], {
      host: HOST,
      session_id: "new",
      pid: 5,
      ts: 500,
    });
    const next = reduce(gone as SessionSnapshot, hook("PostToolUse"));
    expect(next).toMatchObject({ state: "working", state_detail: null, ended_reason: null });
  });

  it("a PostToolUse keeps the tool detail while working or after a permission prompt", () => {
    const working = snap("working", { state_detail: "tool:Bash" });
    expect(reduce(working, hook("PostToolUse")).state_detail).toBe("tool:Bash");
    const asked = reduce(working, hook("PermissionRequest", { tool_name: "Bash" }));
    expect(reduce(asked, hook("PostToolUse")).state_detail).toBe("tool:Bash");
  });
});

describe("finding 3: a subagent tool event does not leave waiting_input", () => {
  const waiting = (): SessionSnapshot =>
    run(snap("working"), [
      ["PreToolUse", { tool_name: "AskUserQuestion" }],
      ["Stop", {}],
    ]);

  it.each(["PreToolUse", "PostToolUse", "PermissionDenied"])(
    "subagent %s keeps waiting_input and the needs-input detail",
    (name) => {
      const prev = waiting();
      expect(prev).toMatchObject({ state: "waiting_input", state_detail: "needs input" });
      expect(reduce(prev, hook(name, { tool_name: "Read" }, 9_000, SUB))).toEqual({
        ...prev,
        last_event_at: 9_000,
      });
    },
  );

  it.each(["PreToolUse", "PostToolUse", "UserPromptSubmit"])(
    "main-thread %s leaves waiting_input",
    (name) => {
      expect(reduce(waiting(), hook(name, { tool_name: "Read" }, 9_000)).state).toBe("working");
    },
  );
});

describe("finding 6: copied text and subagent rows are capped", () => {
  const over = (max: number): string => text(max + 1);

  it("ended_reason: both sides of the cap", () => {
    const at = reduce(snap("idle"), hook("SessionEnd", { reason: text(END_REASON_MAX_CHARS) }));
    expect(at.ended_reason).toBe(text(END_REASON_MAX_CHARS));
    const cut = reduce(snap("idle"), hook("SessionEnd", { reason: text(1_000_000) }));
    expect(cut.ended_reason).toHaveLength(END_REASON_MAX_CHARS);
    expect(cut.ended_reason?.endsWith(TRUNCATION_MARKER)).toBe(true);
    const one = reduce(snap("idle"), hook("SessionEnd", { reason: over(END_REASON_MAX_CHARS) }));
    expect(one.ended_reason).toHaveLength(END_REASON_MAX_CHARS);
  });

  it("model id and display name: both sides of the cap", () => {
    const start = (model: string) => hook("SessionStart", { source: "resume", model });
    const at = reduce(snap("working"), start(text(MODEL_ID_MAX_CHARS)));
    const fit = text(MODEL_ID_MAX_CHARS);
    expect(at.model).toEqual({ id: fit, display_name: fit });
    const cut = reduce(snap("working"), start(over(MODEL_ID_MAX_CHARS)));
    expect(cut.model?.id).toHaveLength(MODEL_ID_MAX_CHARS);
    expect(cut.model?.display_name).toHaveLength(MODEL_ID_MAX_CHARS);
    const same = reduce(cut, hook("SessionStart", { source: "compact", model: text(5_000) }));
    expect(same.model).toBe(cut.model);
  });

  it("agent_type and agent_id: capped; SubagentStop matches the capped id", () => {
    const long = over(AGENT_ID_MAX_CHARS);
    const start = hook("SubagentStart", { agent_id: long, agent_type: over(AGENT_TYPE_MAX_CHARS) });
    const one = reduce(snap("working"), start);
    expect(one.subagents[0]?.agent_id).toHaveLength(AGENT_ID_MAX_CHARS);
    expect(one.subagents[0]?.agent_type).toHaveLength(AGENT_TYPE_MAX_CHARS);
    const exact = { agent_id: text(AGENT_ID_MAX_CHARS), agent_type: text(AGENT_TYPE_MAX_CHARS) };
    const fits = reduce(snap("working"), hook("SubagentStart", exact));
    expect(fits.subagents[0]).toMatchObject(exact);
    const stopped = reduce(one, hook("SubagentStop", { agent_id: long }, 9_000));
    expect(stopped.subagents[0]?.ended_at).toBe(9_000);
  });

  it("an envelope agent_id is capped in tracking.permission", () => {
    const e = hook("PermissionRequest", {}, T0 + 1, { agent_id: text(5_000) });
    const held = reduce(snap("working"), e).tracking.permission;
    expect(held).toMatchObject({ agent_id: expect.stringMatching(/^x+\.\.\.\[truncated\]$/) });
    expect(held && "agent_id" in held ? held.agent_id : "").toHaveLength(AGENT_ID_MAX_CHARS);
  });

  const row = (i: number, ended: boolean): SubagentSnapshot => ({
    agent_id: `a${i}`,
    agent_type: "t",
    started_at: i,
    ended_at: ended ? 1_000 + i : null,
    tokens: null,
    context_window: null,
    model: null,
  });
  const rows = (n: number, endedIdx: readonly number[] = []): SubagentSnapshot[] =>
    Array.from({ length: n }, (_, i) => row(i, endedIdx.includes(i)));
  const start = (id: string) => hook("SubagentStart", { agent_id: id, agent_type: "t" }, 5_000);

  it("exactly the cap keeps every row; one more drops the oldest ended row first", () => {
    const almost = snap("working", { subagents: rows(SUBAGENT_ROWS_MAX - 1, [3]) });
    const atCap = reduce(almost, start("new"));
    expect(atCap.subagents).toHaveLength(SUBAGENT_ROWS_MAX);
    expect(atCap.subagents.map((a) => a.agent_id)).toContain("a3");
    const over1 = reduce(atCap, start("newer"));
    expect(over1.subagents).toHaveLength(SUBAGENT_ROWS_MAX);
    const ids = over1.subagents.map((a) => a.agent_id);
    expect(ids).not.toContain("a3");
    expect(ids).toContain("a0");
    expect(ids.at(-1)).toBe("newer");
  });

  it("running rows survive while an ended row can go; all running drops the oldest", () => {
    const mixed = snap("working", { subagents: rows(SUBAGENT_ROWS_MAX, [10, 20]) });
    const ids = reduce(mixed, start("n1")).subagents.map((a) => a.agent_id);
    expect(ids).toHaveLength(SUBAGENT_ROWS_MAX);
    expect(ids).not.toContain("a10");
    expect(ids).toContain("a0");
    expect(ids).toContain("a20");
    const running = snap("working", { subagents: rows(SUBAGENT_ROWS_MAX) });
    const dropped = reduce(running, start("n2")).subagents.map((a) => a.agent_id);
    expect(dropped).toHaveLength(SUBAGENT_ROWS_MAX);
    expect(dropped).not.toContain("a0");
    expect(dropped.at(-1)).toBe("n2");
  });
});

describe("finding 8: nothing throws on a snapshot with damaged tracking", () => {
  const damaged: unknown[] = [
    undefined,
    null,
    "x",
    7,
    [],
    {},
    { last_tool: 5, permission: 3 },
    { last_tool: "Bash", permission: { tool: 1, agent_id: {} } },
    { last_tool: "Bash", permission: { tool: "Bash" } },
    { last_tool: "Bash", permission: { tool: "Bash", agent_id: null } },
  ];
  const wellFormed = (s: SessionSnapshot): void => {
    expect(s.tracking).toEqual(readTracking(s.tracking));
    expect(Object.keys(s.tracking).sort()).toEqual(["last_tool", "permission"]);
  };
  const withTracking = (state: SessionState, tracking: unknown): SessionSnapshot =>
    ({ ...snap(state, { pid: 5 }), tracking }) as unknown as SessionSnapshot;

  it("reduce: every state x event x damaged tracking gives a well-formed tracking", () => {
    const payload = { notification_type: "permission_prompt", source: "startup" };
    for (const state of SESSION_STATES) {
      for (const tracking of damaged) {
        for (const name of [...HOOK_EVENTS, "Unknown"]) {
          const next = reduce(withTracking(state, tracking), hook(name, payload, 9_000));
          wellFormed(next);
          expect(next.last_event_at).toBe(9_000);
        }
      }
    }
  });

  it("reduceLiveness and supersedeSamePid return a well-formed tracking", () => {
    for (const tracking of damaged) {
      const prev = withTracking("working", tracking);
      wellFormed(reduceLiveness(prev, liveness({ pid: 5, alive: false })));
      wellFormed(reduceLiveness(prev, liveness("bad")));
      wellFormed(reduceLiveness(prev, liveness({ pid: 5, alive: true })));
      const [gone] = supersedeSamePid([prev], { host: HOST, session_id: "new", pid: 5, ts: 9_000 });
      expect(gone?.state).toBe("ended");
      wellFormed(gone as SessionSnapshot);
    }
  });

  it("a damaged holder counts as no holder; a well-formed one is kept", () => {
    const bad = withTracking("waiting_permission", { last_tool: null, permission: 3 });
    expect(reduce(bad, hook("PostToolUse", {}, 9_000, SUB)).state).toBe("working");
    const holder = { tool: "Bash", agent_id: null };
    const good = withTracking("waiting_permission", { last_tool: null, permission: holder });
    expect(reduce(good, hook("PostToolUse", {}, 9_000, SUB)).state).toBe("waiting_permission");
    expect(readTracking(undefined)).toEqual(createTracking());
  });
});
