/*
 * Review iteration 1 (R0.2, R0.3): who may leave waiting_permission, and the reducer's explicit
 * tracking field. Every payload is SYNTHETIC (documented fields only).
 */
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../src/snapshot";
import { reduce, reduceLiveness, supersedeSamePid } from "../src/state";
import { HOST, T0, hook, liveness, snap } from "./state-helpers";

const SUB = { agent_id: "agent-1" };
const OTHER = { agent_id: "agent-2" };
const TOOL_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
] as const;

function run(
  start: SessionSnapshot,
  steps: readonly [string, unknown?, { agent_id: string }?][],
): SessionSnapshot {
  return steps.reduce(
    (s, [name, payload, extra], i) => reduce(s, hook(name, payload ?? {}, T0 + 10 + i, extra)),
    start,
  );
}

describe("MAJOR: only the requesting context leaves waiting_permission", () => {
  it("permission held by main thread survives a subagent's tool events", () => {
    const asked = run(snap("working"), [["PermissionRequest", { tool_name: "Bash" }]]);
    expect(asked.state).toBe("waiting_permission");
    for (const name of TOOL_EVENTS) {
      const next = reduce(asked, hook(name, { tool_name: "Read" }, 9_000, SUB));
      expect(next).toEqual({ ...asked, last_event_at: 9_000 });
    }
    const flapped = run(asked, [
      ["PreToolUse", { tool_name: "Read" }, SUB],
      ["Notification", { notification_type: "permission_prompt" }],
      ["PostToolUse", {}, SUB],
    ]);
    expect(flapped.state).toBe("waiting_permission");
    expect(flapped.state_detail).toBe("tool:Bash");
  });

  it.each(TOOL_EVENTS)("%s from the requesting main thread leaves waiting_permission", (name) => {
    const asked = run(snap("working"), [["PermissionRequest", { tool_name: "Bash" }]]);
    const next = reduce(asked, hook(name, { tool_name: "Bash" }, 9_000));
    expect(next.state).toBe("working");
    expect(next.state_since).toBe(9_000);
    expect(next.tracking.permission).toBeNull();
  });

  it.each(TOOL_EVENTS)("%s: only the subagent that asked leaves, not main or another", (name) => {
    const asked = run(snap("working"), [["PermissionRequest", { tool_name: "Bash" }, SUB]]);
    expect(asked.tracking.permission).toEqual({ tool: "Bash", agent_id: "agent-1" });
    expect(reduce(asked, hook(name, {}, 9_000)).state).toBe("waiting_permission");
    expect(reduce(asked, hook(name, {}, 9_000, OTHER)).state).toBe("waiting_permission");
    expect(reduce(asked, hook(name, {}, 9_000, SUB)).state).toBe("working");
  });

  it("a main-thread PreToolUse while a subagent holds the prompt never writes last_tool", () => {
    const asked = run(snap("working", { tracking: { last_tool: "Bash", permission: null } }), [
      ["PermissionRequest", { tool_name: "Write" }, SUB],
    ]);
    const next = reduce(asked, hook("PreToolUse", { tool_name: "AskUserQuestion" }, 9_000));
    expect(next.tracking.last_tool).toBe("Bash");
    expect(next.state).toBe("waiting_permission");
  });

  it.each([
    ["UserPromptSubmit", {}, undefined],
    ["Stop", {}, undefined],
    ["StopFailure", { error: "x" }, undefined],
    ["StopFailure", { error: "x" }, SUB],
    ["SessionEnd", { reason: "other" }, undefined],
    ["SessionStart", { source: "resume" }, undefined],
    ["SessionStart", { source: "startup" }, SUB],
  ] as const)("%s (agent %j) leaves the prompt whoever asked", (name, payload, extra) => {
    for (const asker of [undefined, SUB]) {
      const asked = run(snap("working"), [["PermissionRequest", { tool_name: "Bash" }, asker]]);
      const next = reduce(asked, hook(name, payload, 9_000, extra));
      expect(next.state).not.toBe("waiting_permission");
      expect(next.tracking.permission).toBeNull();
    }
  });

  it("when the requester is unknown (permission null) any context leaves", () => {
    const prev = snap("waiting_permission");
    expect(reduce(prev, hook("PostToolUse", {}, 9_000, SUB)).state).toBe("working");
  });

  it("parallel tool calls inside the requesting context are an open case", () => {
    // Two PreToolUse in flight from the same context: the first PostToolUse also leaves
    // waiting_permission although the second tool's prompt may still be open.
    expect(reduce(snap("waiting_permission"), hook("PostToolUse")).state).toBe("working");
  });

  // TODO(fixture): parallel tool calls in the requesting context. Intended: a PostToolUse for a
  // tool other than the one that asked must not leave waiting_permission; needs tool_use_id fixtures.
  it.skip("a PostToolUse of another parallel tool call keeps the prompt open", () => {
    expect.fail("TODO(fixture): write once parallel-tool PermissionRequest fixtures exist");
  });
});

describe("tracking.permission bookkeeping", () => {
  it("PermissionRequest records its own tool and agent; state_detail comes from tool_name", () => {
    const main = reduce(
      snap("working", { state_detail: "tool:Read" }),
      hook("PermissionRequest", { tool_name: "Bash" }),
    );
    expect(main.state_detail).toBe("tool:Bash");
    expect(main.tracking.permission).toEqual({ tool: "Bash", agent_id: null });
    const bare = reduce(snap("working"), hook("PermissionRequest", {}, T0 + 1, SUB));
    expect(bare.state_detail).toBe("tool:unknown");
    expect(bare.tracking.permission).toEqual({ tool: null, agent_id: "agent-1" });
  });

  it("main PreToolUse(Bash), subagent PreToolUse(Read), main PermissionRequest(Bash) shows Bash", () => {
    const next = run(snap("working"), [
      ["PreToolUse", { tool_name: "Bash" }],
      ["PreToolUse", { tool_name: "Read" }, SUB],
      ["PermissionRequest", { tool_name: "Bash" }],
    ]);
    expect(next.state_detail).toBe("tool:Bash");
  });

  it("the Notification fallback with an agent_id records that agent and no tool; detail is kept", () => {
    const n = hook("Notification", { notification_type: "elicitation_dialog" }, T0 + 1, SUB);
    const next = reduce(snap("working", { state_detail: "tool:Bash" }), n);
    expect(next.tracking.permission).toEqual({ tool: null, agent_id: "agent-1" });
    expect(next.state_detail).toBe("tool:Bash");
  });

  it("the Notification fallback without an agent_id records an explicit unknown requester", () => {
    const n = hook("Notification", { notification_type: "permission_prompt" });
    const next = reduce(snap("working", { state_detail: "tool:Bash" }), n);
    expect(next.tracking.permission).toEqual({ tool: null, requester_unknown: true });
    expect(next.state_detail).toBe("tool:Bash");
  });

  it("a second PermissionRequest from another context becomes the holder", () => {
    const next = run(snap("working"), [
      ["PermissionRequest", { tool_name: "Bash" }],
      ["PermissionRequest", { tool_name: "Write" }, SUB],
    ]);
    expect(next.tracking.permission).toEqual({ tool: "Write", agent_id: "agent-1" });
  });

  it("is cleared when SessionEnd, liveness or supersede leave waiting_permission", () => {
    const asked = run(snap("working", { pid: 5 }), [["PermissionRequest", { tool_name: "Bash" }]]);
    expect(asked.tracking.permission).not.toBeNull();
    expect(reduce(asked, hook("SessionEnd", { reason: "other" })).tracking.permission).toBeNull();
    const dead = reduceLiveness(asked, liveness({ pid: 5, alive: false }));
    expect(dead.tracking.permission).toBeNull();
    const [gone] = supersedeSamePid([asked], { host: HOST, session_id: "new", pid: 5, ts: 9_000 });
    expect(gone?.tracking.permission).toBeNull();
  });
});
