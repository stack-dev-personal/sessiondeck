/*
 * U3 fix round 1 (R0.3): a subagent's tool event does not leave `idle`, exactly as it does not leave
 * `waiting_input`. Payloads are SYNTHETIC (documented field lists); the captured-golden check is in
 * state-golden.test.ts.
 */
import { describe, expect, it } from "vitest";
import { reduce } from "../src/state";
import { GUARD_DESCRIPTIONS } from "../src/transitions";
import { T0, hook, snap } from "./state-helpers";

const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"] as const;
const SUB = { agent_id: "agent-1" };

describe("idle guard for subagent tool events", () => {
  it.each(TOOL_EVENTS)("a subagent %s over idle stays idle (only last_event_at moves)", (name) => {
    const prev = snap("idle", { state_since: 500, state_detail: null });
    const next = reduce(prev, hook(name, { tool_name: "Bash" }, T0 + 9, SUB));
    expect(next).toEqual({ ...prev, last_event_at: T0 + 9 });
  });

  it.each(TOOL_EVENTS)("a main-thread %s over idle leaves idle", (name) => {
    const next = reduce(snap("idle"), hook(name, { tool_name: "Bash" }, T0 + 9));
    expect(next.state).toBe("working");
    expect(next.state_since).toBe(T0 + 9);
  });

  it.each(TOOL_EVENTS)("a subagent %s over waiting_input still stays", (name) => {
    expect(reduce(snap("waiting_input"), hook(name, {}, T0 + 2, SUB)).state).toBe("waiting_input");
  });

  it.each(["working", "starting", "error"] as const)(
    "a subagent PreToolUse over %s is unchanged by the guard (working)",
    (state) => {
      expect(reduce(snap(state), hook("PreToolUse", {}, T0 + 2, SUB)).state).toBe("working");
    },
  );

  it("UserPromptSubmit still leaves idle", () => {
    expect(reduce(snap("idle"), hook("UserPromptSubmit", {})).state).toBe("working");
  });

  it("a subagent tool event still revives exited (the guard covers idle and waiting_input only)", () => {
    expect(reduce(snap("exited"), hook("PostToolUse", {}, T0 + 2, SUB)).state).toBe("working");
  });

  it("the guard text names idle", () => {
    expect(GUARD_DESCRIPTIONS.not_subagent_over_input).toContain("idle");
  });
});
