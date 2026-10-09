/*
 * Review iteration 1 (R0.2, R0.3): superseded revival, SessionStart, PostCompact, liveness pid,
 * routing, tracking.last_tool, length caps, table-only behavior. SYNTHETIC payloads only.
 */
import { describe, expect, it } from "vitest";
import {
  LAST_MESSAGE_MAX_CHARS,
  LAST_PROMPT_MAX_CHARS,
  STATE_DETAIL_MAX_CHARS,
  TOOL_NAME_MAX_CHARS,
  TRUNCATION_MARKER,
  truncate,
} from "../src/limits";
import type { SessionSnapshot } from "../src/snapshot";
import {
  HOOK_EVENTS,
  SESSION_STATES,
  SUPERSEDED_REASON,
  TRANSITIONS,
  reduce,
  reduceLiveness,
  supersedeSamePid,
} from "../src/state";
import { rowState, selectTransition } from "../src/transitions";
import { HOST, T0, hook, liveness, snap } from "./state-helpers";

const SUB = { agent_id: "agent-1" };
const superseded = (over: Partial<SessionSnapshot> = {}): SessionSnapshot =>
  snap("ended", { ended_reason: SUPERSEDED_REASON, state_detail: "superseded", ...over });

function run(
  start: SessionSnapshot,
  steps: readonly [string, unknown?, { agent_id: string }?][],
): SessionSnapshot {
  return steps.reduce(
    (s, [name, payload, extra], i) => reduce(s, hook(name, payload ?? {}, T0 + 10 + i, extra)),
    start,
  );
}

describe("MAJOR: a superseded session is revivable by any hook for it", () => {
  it.each([
    ["PreToolUse", { tool_name: "Bash" }, "working"],
    ["PostToolUse", {}, "working"],
    ["UserPromptSubmit", {}, "working"],
    ["PostCompact", {}, "working"],
    ["Stop", {}, "idle"],
    ["StopFailure", { error: "x" }, "error"],
    ["PermissionRequest", { tool_name: "Bash" }, "waiting_permission"],
    ["Notification", { notification_type: "permission_prompt" }, "waiting_permission"],
    ["SessionStart", { source: "resume" }, "starting"],
  ])("superseded then %s revives to %s and clears ended_reason", (name, payload, state) => {
    const next = reduce(superseded(), hook(name, payload, 9_000));
    expect(next.state).toBe(state);
    expect(next.ended_reason).toBeNull();
    expect(next.state_since).toBe(9_000);
  });

  it("old id keeps working after the new id appears (after --continue, events continue)", () => {
    const old = snap("working", { pid: 77 });
    const [ended] = supersedeSamePid([old], { host: HOST, session_id: "new", pid: 77, ts: 5_000 });
    expect(ended?.state).toBe("ended");
    const next = reduce(ended as SessionSnapshot, hook("PreToolUse", { tool_name: "Bash" }, 6_000));
    expect(next).toMatchObject({ state: "working", ended_reason: null });
  });

  it("SessionEnd still ends it, with the reported reason; compact SessionStart and subagent Stop do not revive", () => {
    const ended = reduce(superseded(), hook("SessionEnd", { reason: "logout" }));
    expect(ended).toMatchObject({ state: "ended", ended_reason: "logout" });
    expect(rowState(ended)).toBe("ended");
    expect(reduce(ended, hook("PreToolUse")).state).toBe("ended");
    const compact = reduce(superseded(), hook("SessionStart", { source: "compact" }));
    expect(compact).toEqual({ ...superseded(), last_event_at: T0 + 1 });
    const sub = reduce(superseded(), hook("Stop", {}, T0 + 1, SUB));
    expect(sub).toEqual({ ...superseded(), last_event_at: T0 + 1 });
  });

  it("a superseded session is not touched by liveness or a second supersede", () => {
    const s = superseded({ pid: 77 });
    expect(reduceLiveness(s, liveness({ pid: 77, alive: false })).state_detail).toBe("superseded");
    const again = supersedeSamePid([s], { host: HOST, session_id: "x", pid: 77, ts: 9_000 });
    expect(again[0]).toBe(s);
  });

  it("only events with no row leave it untouched", () => {
    const s = superseded();
    expect(reduce(s, hook("TaskCreated", { subject: "x" }))).toEqual({
      ...s,
      last_event_at: T0 + 1,
    });
  });
});

describe("MINOR: SessionStart is a row from every state", () => {
  it.each(["working", "waiting_permission", "waiting_input", "idle", "error"] as const)(
    "resume from %s goes to starting and resets tracking",
    (state) => {
      const prev = snap(state, {
        state_detail: "old",
        tracking: { last_tool: "Bash", permission: { tool: "Bash", agent_id: null } },
      });
      const next = reduce(prev, hook("SessionStart", { source: "resume" }, 9_000));
      expect(next).toMatchObject({
        state: "starting",
        state_since: 9_000,
        state_detail: "source:resume",
        tracking: { last_tool: null, permission: null },
      });
    },
  );

  it.each(SESSION_STATES)("source compact changes nothing from %s but last_event_at", (state) => {
    const prev = snap(state, {
      state_detail: "old",
      ended_reason: state === "ended" ? "clear" : null,
      tracking: { last_tool: "Bash", permission: null },
    });
    const next = reduce(prev, hook("SessionStart", { source: "compact" }, 9_000));
    expect(next.state).toBe(state);
    expect(next.state_detail).toBe("old");
    expect(next.ended_reason).toBe(prev.ended_reason);
    expect(next.tracking.last_tool).toBe("Bash");
  });
});

describe("MINOR: PostCompact only moves the mid-turn states", () => {
  it.each(["idle", "waiting_input", "waiting_permission", "error"] as const)(
    "from %s it counts the compaction and nothing else",
    (state) => {
      const prev = snap(state, { state_detail: "keepme", state_since: 400, compactions: 1 });
      const next = reduce(prev, hook("PostCompact", {}, 9_000));
      expect(next).toEqual({ ...prev, compactions: 2, last_event_at: 9_000 });
    },
  );

  it.each(["exited"] as const)("from %s a hook proves life, so it goes to working", (state) => {
    expect(reduce(snap(state), hook("PostCompact")).state).toBe("working");
    expect(reduce(superseded(), hook("PostCompact")).state).toBe("working");
  });
});

describe("MINOR: PostToolUseFailure and PermissionDenied rows", () => {
  it("PostToolUseFailure leaves waiting_permission for working with the detail kept", () => {
    const prev = snap("waiting_permission", { state_detail: "tool:Bash" });
    const next = reduce(prev, hook("PostToolUseFailure", { error: "exit 1" }, 9_000));
    expect(next).toMatchObject({ state: "working", state_detail: "tool:Bash", state_since: 9_000 });
  });

  it.each(["working", "idle", "error", "waiting_input"] as const)(
    "PostToolUseFailure from %s is unchanged (provisional)",
    (state) => {
      const prev = snap(state, { state_detail: "d" });
      expect(reduce(prev, hook("PostToolUseFailure", {}, 9_000))).toEqual({
        ...prev,
        last_event_at: 9_000,
      });
    },
  );

  it("PermissionDenied clears the detail", () => {
    const prev = snap("waiting_permission", { state_detail: "tool:Bash" });
    expect(reduce(prev, hook("PermissionDenied")).state_detail).toBeNull();
  });

  it.each(["starting", "working", "idle", "error", "exited"] as const)(
    "a permission Notification falls back from %s; detail is kept",
    (state) => {
      const n = hook("Notification", { notification_type: "permission_prompt" });
      const next = reduce(snap(state, { state_detail: "tool:Bash" }), n);
      expect(next).toMatchObject({ state: "waiting_permission", state_detail: "tool:Bash" });
    },
  );

  it("an unknown trigger name (liveness_dead, superseded) arriving as a hook does nothing", () => {
    for (const name of ["liveness_dead", "superseded"]) {
      const prev = snap("working");
      expect(reduce(prev, hook(name, { pid: 1, alive: false }))).toEqual({
        ...prev,
        last_event_at: T0 + 1,
      });
    }
  });
});

describe("MINOR: liveness alive:false for another pid is ignored", () => {
  it("a dead report for pid 100 does not exit a session now under pid 200", () => {
    const prev = snap("working", { pid: 200 });
    const next = reduceLiveness(prev, liveness({ pid: 100, alive: false }, 9_000));
    expect(next).toEqual({ ...prev, last_event_at: 9_000 });
  });

  it("the matching pid, or no pid on record yet, still exits", () => {
    expect(
      reduceLiveness(snap("working", { pid: 100 }), liveness({ pid: 100, alive: false })).state,
    ).toBe("exited");
    expect(reduceLiveness(snap("working"), liveness({ pid: 100, alive: false })).state).toBe(
      "exited",
    );
  });

  it("a later alive:true revives nothing but records the pid", () => {
    const exited = reduceLiveness(snap("working"), liveness({ pid: 100, alive: false }));
    expect(reduceLiveness(exited, liveness({ pid: 200, alive: true })).pid).toBe(200);
  });
});

describe("MINOR: routing precondition", () => {
  const prev = snap("working");

  it("returns prev itself for another session_id or host (hooks and liveness)", () => {
    expect(reduce(prev, { ...hook("SessionEnd"), session_id: "other" })).toBe(prev);
    expect(reduce(prev, { ...hook("SessionEnd"), host: "other-host" })).toBe(prev);
    expect(reduce(prev, { ...hook("SessionEnd"), session_id: null })).toBe(prev);
    const dead = liveness({ pid: 1, alive: false });
    expect(reduceLiveness(prev, { ...dead, session_id: "other" })).toBe(prev);
    expect(reduceLiveness(prev, { ...dead, host: "other-host" })).toBe(prev);
  });

  it("a matching session and host is applied", () => {
    expect(reduce(prev, hook("SessionEnd")).state).toBe("ended");
  });
});

describe("tracking.last_tool", () => {
  it("a background subagent's tool does not hide AskUserQuestion from Stop", () => {
    const next = run(snap("working"), [
      ["PreToolUse", { tool_name: "AskUserQuestion" }],
      ["PreToolUse", { tool_name: "Grep" }, SUB],
      ["PostToolUse", {}, SUB],
      ["Stop", {}],
    ]);
    expect(next).toMatchObject({ state: "waiting_input", state_detail: "needs input" });
  });

  it("subagent PreToolUse writes neither last_tool nor the detail while working", () => {
    const mid = run(snap("working"), [["PreToolUse", { tool_name: "Bash" }]]);
    const next = reduce(mid, hook("PreToolUse", { tool_name: "Read" }, 9_000, SUB));
    expect(next.tracking.last_tool).toBe("Bash");
    expect(next.state_detail).toBe("tool:Bash");
  });

  it("subagent PreToolUse from a non-working state shows no stale detail", () => {
    const next = reduce(
      snap("waiting_input", { state_detail: "needs input" }),
      hook("PreToolUse", { tool_name: "Read" }, 9_000, SUB),
    );
    expect(next).toMatchObject({ state: "working", state_detail: null });
  });

  it("is cleared by UserPromptSubmit and Stop, and null when the tool name is unusable", () => {
    const tool = run(snap("working"), [["PreToolUse", { tool_name: "ExitPlanMode" }]]);
    expect(tool.tracking.last_tool).toBe("ExitPlanMode");
    expect(run(tool, [["UserPromptSubmit"]]).tracking.last_tool).toBeNull();
    expect(run(tool, [["Stop"]]).tracking.last_tool).toBeNull();
    expect(run(tool, [["PreToolUse", { tool_name: 3 }]]).tracking.last_tool).toBeNull();
  });

  it("AskUserQuestion, permission Notification, Stop still gives waiting_input", () => {
    const next = run(snap("working"), [
      ["PreToolUse", { tool_name: "AskUserQuestion" }],
      ["Notification", { notification_type: "permission_prompt" }],
      ["PostToolUse", {}],
      ["Stop", {}],
    ]);
    expect(next.state).toBe("waiting_input");
  });

  it("a subagent's Stop never gives waiting_input, even after ExitPlanMode", () => {
    const prev = snap("working", { tracking: { last_tool: "ExitPlanMode", permission: null } });
    expect(reduce(prev, hook("Stop", {}, T0 + 1, SUB)).state).toBe("working");
    const ask = snap("working", { tracking: { last_tool: "AskUserQuestion", permission: null } });
    expect(reduce(ask, hook("Stop", {}, T0 + 1, SUB)).state).toBe("working");
  });

  it("logic never reads state_detail: a forged detail does not steer Stop", () => {
    const prev = snap("working", { state_detail: "tool:AskUserQuestion" });
    expect(reduce(prev, hook("Stop")).state).toBe("idle");
  });
});

describe("MINOR: length caps", () => {
  const text = (n: number): string => "x".repeat(n);

  it("last_prompt: exactly the cap is kept, one over is cut to the cap with a marker", () => {
    const ok = reduce(
      snap("idle"),
      hook("UserPromptSubmit", { prompt: text(LAST_PROMPT_MAX_CHARS) }),
    );
    expect(ok.last_prompt).toBe(text(LAST_PROMPT_MAX_CHARS));
    const cut = reduce(snap("idle"), hook("UserPromptSubmit", { prompt: text(500_000) }));
    expect(cut.last_prompt).toHaveLength(LAST_PROMPT_MAX_CHARS);
    expect(cut.last_prompt?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("last_assistant_message: both sides of the cap", () => {
    const at = reduce(
      snap("working"),
      hook("Stop", { last_assistant_message: text(LAST_MESSAGE_MAX_CHARS) }),
    );
    expect(at.last_assistant_message).toHaveLength(LAST_MESSAGE_MAX_CHARS);
    expect(at.last_assistant_message?.endsWith(TRUNCATION_MARKER)).toBe(false);
    const over = reduce(
      snap("working"),
      hook("Stop", { last_assistant_message: text(LAST_MESSAGE_MAX_CHARS + 1) }),
    );
    expect(over.last_assistant_message).toHaveLength(LAST_MESSAGE_MAX_CHARS);
    expect(over.last_assistant_message?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("state_detail from tool_name and error: both sides of the cap", () => {
    const fits = text(STATE_DETAIL_MAX_CHARS - "tool:".length);
    const at = reduce(snap("working"), hook("PreToolUse", { tool_name: fits }));
    expect(at.state_detail).toBe(`tool:${fits}`);
    const over = reduce(snap("working"), hook("PreToolUse", { tool_name: `${fits}y` }));
    expect(over.state_detail).toHaveLength(STATE_DETAIL_MAX_CHARS);
    expect(over.state_detail?.endsWith(TRUNCATION_MARKER)).toBe(true);
    const err = reduce(snap("working"), hook("StopFailure", { error: text(5_000) }));
    expect(err.state_detail).toHaveLength(STATE_DETAIL_MAX_CHARS);
    const perm = reduce(snap("working"), hook("PermissionRequest", { tool_name: text(5_000) }));
    expect(perm.state_detail).toHaveLength(STATE_DETAIL_MAX_CHARS);
    expect(perm.tracking.permission?.tool).toHaveLength(TOOL_NAME_MAX_CHARS);
  });

  it("tracking.last_tool is capped", () => {
    const next = reduce(snap("working"), hook("PreToolUse", { tool_name: text(5_000) }));
    expect(next.tracking.last_tool).toHaveLength(TOOL_NAME_MAX_CHARS);
  });

  it("truncate never splits a surrogate pair and handles tiny caps", () => {
    const cut = 20 - TRUNCATION_MARKER.length;
    const out = truncate(`${"a".repeat(cut - 1)}\u{1F600}${"b".repeat(50)}`, 20);
    expect(out).toBe(`${"a".repeat(cut - 1)}${TRUNCATION_MARKER}`);
    expect(truncate("abcdef", 3)).toBe("abc");
    expect(truncate("abcdef", -1)).toBe("");
  });
});

describe("the table is the only source of ended behavior", () => {
  it("for every hook event, an ended session moves exactly when a row matches", () => {
    const ended = snap("ended", { ended_reason: "clear" });
    for (const name of HOOK_EVENTS) {
      const payload = { source: "startup" };
      const ctx = { prev: ended, agentId: null, payload };
      const row = selectTransition(name, ctx);
      const next = reduce(ended, hook(name, payload));
      if (row === undefined) expect(next).toEqual({ ...ended, last_event_at: T0 + 1 });
      else expect(next.state).toBe(row.to);
    }
  });

  it("only SessionStart has a row from a normal ended", () => {
    const fromEnded = TRANSITIONS.filter((t) => t.from.includes("ended"));
    expect(fromEnded.map((t) => t.trigger)).toEqual(["SessionStart"]);
  });
});
