/*
 * Reducer behavior pinned against committed fixtures (R0.2, R0.3). Captured payloads come from
 * fixtures/<Event>/ (scrubbed real captures, 2026-10-15). Tests named "(synthetic payload, not
 * captured)" use fixtures/synthetic/, which follow the hooks reference (conductor decision 7).
 * Tests named "provisional: not observed in the 2026-10-15 capture" pin today's behavior for a case
 * the capture did not contain; they are not evidence that the behavior is right.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../src/snapshot";
import { TASK_SUBJECT_MAX_CHARS, TRUNCATION_MARKER } from "../src/limits";
import { reduce } from "../src/state";
import {
  fixtureAt,
  hookEnvelope,
  replay,
  snapshotFor,
  tsOfEvent,
  withPayload,
} from "./golden-helpers";
import type { LoadedFixture } from "./helpers";
import { FIXTURES_DIR, loadFixtures } from "./helpers";

const NOTE = "provisional: not observed in the 2026-10-15 capture";

function names(dir: string): string[] {
  return readdirSync(join(FIXTURES_DIR, dir)).filter((f) => f.endsWith(".json"));
}

// Loaded once per file: each loadFixtures() walks and parses every committed fixture, and the
// tests only read the payloads (withPayload copies before changing anything).
const ALL_FIXTURES: readonly LoadedFixture[] = Object.freeze(loadFixtures());

/** Every committed fixture of one event. */
const all = (dir: string): LoadedFixture[] => ALL_FIXTURES.filter((f) => f.dir === dir);

/** Applies one fixture to a snapshot of its own session in `state`, with optional overrides. */
function applyTo(
  fx: LoadedFixture,
  state: Parameters<typeof snapshotFor>[1],
  patch: Partial<SessionSnapshot> = {},
) {
  const prev = { ...snapshotFor(fx, state), ...patch };
  return { prev, next: reduce(prev, hookEnvelope(fx, 0)) };
}

describe("R0.3 captured sequences", () => {
  // fixtures of session fc727a7b, in the order the capture recorded them (PreToolUse, then
  // PermissionRequest, then the permission_prompt Notification about 6 seconds later)
  const ask = fixtureAt("PreToolUse", "04-askuserquestion.json");
  const request = fixtureAt("PermissionRequest", "01-askuserquestion.json");
  const notification = fixtureAt("Notification", "02-permission-prompt.json");
  const answered = fixtureAt("PostToolUse", "05-askuserquestion.json");
  const stopAfterAsk = fixtureAt("Stop", "01-after-ask.json");

  it("PermissionRequest -> waiting_permission, for every captured PermissionRequest", () => {
    const fixtures = all("PermissionRequest");
    expect(fixtures).toHaveLength(4);
    for (const fx of fixtures) {
      const { next } = applyTo(fx, "working");
      const tool = (fx.payload as { tool_name: string }).tool_name;
      expect(next.state, fx.file).toBe("waiting_permission");
      expect(next.state_detail, fx.file).toBe(`tool:${tool}`);
      expect(next.tracking.permission, fx.file).toEqual({ tool, agent_id: null });
    }
  });

  it("Notification permission_prompt while already waiting_permission is a no-op", () => {
    const waiting = replay(snapshotFor(ask), [ask, request]);
    expect(waiting.state).toBe("waiting_permission");
    const next = reduce(waiting, hookEnvelope(notification, 2));
    expect(next).toEqual({ ...waiting, last_event_at: tsOfEvent(2) });
  });

  it("Stop after PreToolUse(AskUserQuestion) -> waiting_input 'needs input'", () => {
    const after = replay(snapshotFor(ask), [ask, stopAfterAsk]);
    expect(after.state).toBe("waiting_input");
    expect(after.state_detail).toBe("needs input");
  });

  it("the whole captured ask sequence ends in waiting_input", () => {
    const states = [ask, request, notification, answered, stopAfterAsk].map(
      (_, i, all5) => replay(snapshotFor(ask), all5.slice(0, i + 1)).state,
    );
    expect(states).toEqual([
      "working",
      "waiting_permission",
      "waiting_permission",
      "working",
      "waiting_input",
    ]);
  });

  it("SessionEnd -> ended with the payload reason, for every captured SessionEnd", () => {
    const fixtures = all("SessionEnd");
    expect(fixtures.map((f) => (f.payload as { reason: string }).reason).sort()).toEqual([
      "clear",
      "other",
      "other",
    ]);
    for (const fx of fixtures) {
      const { next } = applyTo(fx, "idle");
      expect(next.state, fx.file).toBe("ended");
      expect(next.ended_reason, fx.file).toBe((fx.payload as { reason: string }).reason);
    }
  });
});

describe("PostToolUseFailure (captured)", () => {
  const failures = all("PostToolUseFailure");

  it("has the captured fields error, is_interrupt and duration_ms", () => {
    expect(failures).toHaveLength(6);
    for (const fx of failures) {
      expect(Object.keys(fx.payload as object), fx.file).toEqual(
        expect.arrayContaining(["error", "is_interrupt", "duration_ms"]),
      );
    }
  });

  it("is a tool failure, never the error state: working stays working with its detail", () => {
    for (const fx of failures) {
      const { prev, next } = applyTo(fx, "working", { state_detail: "tool:Bash", state_since: 5 });
      expect(next.state, fx.file).toBe("working");
      expect(next.state_since, fx.file).toBe(5);
      expect(next.state_detail, fx.file).toBe("tool:Bash");
      expect(next.last_event_at, fx.file).toBe(tsOfEvent(0));
      expect(next.tasks, fx.file).toEqual(prev.tasks);
    }
  });

  it("the main thread's failure ends its own permission prompt", () => {
    const main = failures[0] as LoadedFixture;
    const request = withPayload(fixtureAt("PermissionRequest", "03-bash.json"), {
      session_id: (main.payload as { session_id: string }).session_id,
    });
    const waiting = replay(snapshotFor(main), [request]);
    expect(waiting.state).toBe("waiting_permission");
    expect(reduce(waiting, hookEnvelope(main, 1)).state).toBe("working");
  });

  it("a subagent's failure does not end the main thread's prompt", () => {
    const sub = failures.find((f) => "agent_id" in (f.payload as object)) as LoadedFixture;
    const request = withPayload(fixtureAt("PermissionRequest", "03-bash.json"), {
      session_id: (sub.payload as { session_id: string }).session_id,
    });
    const waiting = replay(snapshotFor(sub), [request]);
    expect(reduce(waiting, hookEnvelope(sub, 1)).state).toBe("waiting_permission");
  });

  it("is proof of tool activity like PostToolUse: idle, error and starting move to working", () => {
    for (const fx of failures) {
      const sub = "agent_id" in (fx.payload as object);
      for (const state of ["starting", "idle", "error"] as const) {
        // A subagent's failure does not leave idle (U3 fix round 1); every other case works.
        const want = sub && state === "idle" ? "idle" : "working";
        expect(applyTo(fx, state).next.state, `${fx.file} from ${state}`).toBe(want);
      }
    }
  });

  it("a subagent's failure never hides waiting_input; the main thread's does", () => {
    const sub = failures.find((f) => "agent_id" in (f.payload as object)) as LoadedFixture;
    const main = failures.find((f) => !("agent_id" in (f.payload as object))) as LoadedFixture;
    expect(applyTo(sub, "waiting_input").next.state).toBe("waiting_input");
    expect(applyTo(main, "waiting_input").next.state).toBe("working");
  });
});

describe("PostToolUse tool_response (captured)", () => {
  const fixtures = all("PostToolUse");
  const shape = (fx: LoadedFixture): string => {
    const r = (fx.payload as { tool_response: unknown }).tool_response;
    return Array.isArray(r) ? "array" : typeof r;
  };

  it("covers the object and array tool_response shapes of the committed fixtures", () => {
    expect(new Set(fixtures.map(shape))).toEqual(new Set(["object", "array"]));
    expect(fixtures).toHaveLength(names("PostToolUse").length);
  });

  it("tool_response is not read: every captured PostToolUse gives working", () => {
    for (const fx of fixtures) {
      for (const state of ["working", "idle"] as const) {
        const { next } = applyTo(fx, state, { state_detail: null });
        const stays = state === "idle" && "agent_id" in (fx.payload as object);
        expect(next.state, `${fx.file} from ${state}`).toBe(stays ? "idle" : "working");
      }
    }
  });

  it("a string tool_response (seen in the full capture, derived from a fixture) gives the same", () => {
    const base = fixtures[0] as LoadedFixture;
    for (const response of ["text result", "", 5, null]) {
      const fx = withPayload(base, { tool_response: response });
      expect(applyTo(fx, "idle").next.state).toBe("working");
    }
  });
});

describe("PreCompact and PostCompact (captured)", () => {
  const pre = fixtureAt("PreCompact", "01-auto.json");
  const post = fixtureAt("PostCompact", "01-auto.json");

  it("PreCompact records the trigger in state_detail while working; the state is unchanged", () => {
    const { prev, next } = applyTo(pre, "working", { state_detail: "tool:Bash", state_since: 7 });
    expect(next.state).toBe("working");
    expect(next.state_since).toBe(7);
    expect(next.state_detail).toBe("compact:auto");
    expect(next.compactions).toBe(prev.compactions);
  });

  it("PostCompact then clears the detail and counts the compaction", () => {
    const compacting = replay(snapshotFor(pre, "working"), [pre]);
    const done = reduce(compacting, hookEnvelope(post, 1));
    expect(done).toMatchObject({ state: "working", state_detail: null, compactions: 1 });
  });

  it.each(["idle", "waiting_input", "waiting_permission", "error"] as const)(
    "PreCompact leaves a %s session's detail alone (PostCompact would not clear it)",
    (state) => {
      const { prev, next } = applyTo(pre, state, { state_detail: "kept" });
      expect(next).toEqual({ ...prev, last_event_at: tsOfEvent(0) });
    },
  );

  it("a PreCompact without a string trigger changes nothing", () => {
    const fx = withPayload(pre, { trigger: 3 });
    const { prev, next } = applyTo(fx, "working", { state_detail: "tool:Bash" });
    expect(next).toEqual({ ...prev, last_event_at: tsOfEvent(0) });
  });
});

describe("TaskCreated and TaskCompleted (synthetic payload, not captured)", () => {
  const created = fixtureAt("synthetic/TaskCreated", "01-synthetic.json");
  const completed = fixtureAt("synthetic/TaskCompleted", "01-synthetic.json");
  const bySubagent = fixtureAt("synthetic/TaskCompleted", "02-subagent.json");
  const subject = (fx: LoadedFixture): string =>
    (fx.payload as { task_subject: string }).task_subject;

  it("TaskCreated increments tasks.total and records last_subject; the state is unchanged", () => {
    const { prev, next } = applyTo(created, "working", { state_detail: "tool:Bash" });
    expect(next.tasks).toEqual({ total: 1, completed: 0, last_subject: subject(created) });
    expect(next).toEqual({ ...prev, last_event_at: tsOfEvent(0), tasks: next.tasks });
  });

  it("TaskCompleted increments tasks.completed and records last_subject", () => {
    const start = replay(snapshotFor(created, "working"), [created]);
    const next = reduce(start, hookEnvelope(completed, 1));
    expect(next.tasks).toEqual({ total: 1, completed: 1, last_subject: subject(completed) });
    expect(next.state).toBe("working");
  });

  it("a subagent's TaskCompleted counts the same", () => {
    const next = reduce(
      replay(snapshotFor(created, "working"), [created]),
      hookEnvelope(bySubagent, 1),
    );
    expect(next.tasks.completed).toBe(1);
    expect(next.state).toBe("working");
  });

  it("completed never exceeds total (a task created before the probe attached)", () => {
    const { next } = applyTo(completed, "working");
    expect(next.tasks).toEqual({ total: 1, completed: 1, last_subject: subject(completed) });
  });

  it("a payload without a string subject still counts and keeps the previous subject", () => {
    const start = replay(snapshotFor(created, "working"), [created]);
    const next = reduce(start, hookEnvelope(withPayload(created, { task_subject: 4 }), 1));
    expect(next.tasks).toEqual({ total: 2, completed: 0, last_subject: subject(created) });
  });

  it("an overlong subject is capped with the visible marker", () => {
    const long = withPayload(created, { task_subject: "x".repeat(TASK_SUBJECT_MAX_CHARS + 50) });
    const subjectOut = applyTo(long, "working").next.tasks.last_subject ?? "";
    expect(subjectOut).toHaveLength(TASK_SUBJECT_MAX_CHARS);
    expect(subjectOut.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("revives an exited session without changing its state (no row)", () => {
    expect(applyTo(created, "exited").next.state).toBe("exited");
  });
});

describe("StopFailure (synthetic payload, not captured)", () => {
  const failure = fixtureAt("synthetic/StopFailure", "01-synthetic.json");

  it("moves a live session to error and records the error type", () => {
    for (const state of ["working", "idle", "waiting_input", "waiting_permission"] as const) {
      const { next } = applyTo(failure, state);
      expect(next.state, state).toBe("error");
      expect(next.state_detail, state).toBe("rate_limit");
    }
  });

  it(`${NOTE}: a subagent's StopFailure also gives error`, () => {
    // derived from the synthetic main-session payload; whether StopFailure carries agent_id is
    // undocumented, so this pins today's "any context" behavior only
    const sub = withPayload(failure, {
      agent_id: "a1b2c3d4e5f60718",
      agent_type: "general-purpose",
    });
    const { next } = applyTo(sub, "working");
    expect(next.state).toBe("error");
    expect(next.state_detail).toBe("rate_limit");
  });
});

describe("open cases (provisional)", () => {
  it(`${NOTE}: parallel tool calls inside the requesting context`, () => {
    // No capture had a second tool in flight in the asking context (the one PermissionRequest with
    // an extra open PreToolUse had an orphan call that never completed). Today any PostToolUse from
    // the requesting context ends the prompt, whichever tool it belongs to.
    const request = fixtureAt("PermissionRequest", "03-bash.json");
    const other = withPayload(fixtureAt("PostToolUse", "04-bash.json"), {
      session_id: (request.payload as { session_id: string }).session_id,
      tool_use_id: "toolu_other_parallel_call",
    });
    const waiting = replay(snapshotFor(request), [request]);
    expect(waiting.state).toBe("waiting_permission");
    expect(reduce(waiting, hookEnvelope(other, 1)).state).toBe("working");
  });

  it(`${NOTE}: a permission Notification carries no agent_id`, () => {
    // Both captured permission_prompt Notifications lacked agent_id and agent_type; no sandbox or
    // subagent prompt was captured. A subagent-asked prompt therefore records an unknown requester
    // and any context's tool event leaves waiting_permission.
    const note = fixtureAt("Notification", "02-permission-prompt.json");
    expect("agent_id" in (note.payload as object)).toBe(false);
    const waiting = replay(snapshotFor(note, "working"), [note]);
    expect(waiting.state).toBe("waiting_permission");
    expect(waiting.tracking.permission).toEqual({ tool: null, requester_unknown: true });
    const sub = fixtureAt("PostToolUse", "14-bash-subagent.json");
    const asSub = withPayload(sub, {
      session_id: (note.payload as { session_id: string }).session_id,
    });
    expect(reduce(waiting, hookEnvelope(asSub, 1)).state).toBe("working");
  });
});
