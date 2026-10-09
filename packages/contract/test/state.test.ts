/*
 * Reducer tests. Every hook payload here is SYNTHETIC: built inline from the documented field
 * lists (docs/hooks.md), not captured. Real-session fixtures arrive with S0b.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../src/snapshot";
import {
  HOOK_EVENTS,
  PROVISIONAL_BEHAVIOR,
  SESSION_STATES,
  SUPERSEDED_REASON,
  TRANSITIONS,
  reduce,
  reduceLiveness,
  supersedeSamePid,
} from "../src/state";
import { HOST, T0, deepFreeze, hook, liveness, snap } from "./state-helpers";

describe("R0.3 clauses", () => {
  it("PermissionRequest moves to waiting_permission", () => {
    const next = reduce(snap("working"), hook("PermissionRequest"));
    expect(next.state).toBe("waiting_permission");
    expect(next.state_since).toBe(T0 + 1);
  });

  it("Notification permission_prompt while already waiting_permission is a no-op", () => {
    const prev = snap("waiting_permission", { state_since: 500, state_detail: "tool:Bash" });
    const next = reduce(
      prev,
      hook("Notification", { notification_type: "permission_prompt" }, 900),
    );
    expect(next.state).toBe("waiting_permission");
    expect(next.state_since).toBe(500);
    expect(next.state_detail).toBe("tool:Bash");
    expect(next.last_event_at).toBe(900);
  });

  it.each(["permission_prompt", "elicitation_dialog"])(
    "Notification %s from working falls back to waiting_permission",
    (type) => {
      const next = reduce(snap("working"), hook("Notification", { notification_type: type }));
      expect(next.state).toBe("waiting_permission");
    },
  );

  it.each(["idle_prompt", "auth_success", 5, null])(
    "Notification type %s changes nothing but last_event_at",
    (type) => {
      const prev = snap("working", { state_since: 500 });
      const next = reduce(prev, hook("Notification", { notification_type: type }));
      expect(next).toEqual({ ...prev, last_event_at: T0 + 1 });
    },
  );

  it("Notification permission_prompt does not pull waiting_input back to waiting_permission", () => {
    const next = reduce(
      snap("waiting_input"),
      hook("Notification", { notification_type: "permission_prompt" }),
    );
    expect(next.state).toBe("waiting_input");
  });

  it("PreToolUse(AskUserQuestion) then Stop gives waiting_input", () => {
    const mid = reduce(snap("working"), hook("PreToolUse", { tool_name: "AskUserQuestion" }));
    expect(mid.state_detail).toBe("tool:AskUserQuestion");
    const next = reduce(mid, hook("Stop", {}, T0 + 2));
    expect(next.state).toBe("waiting_input");
    expect(next.state_detail).toBe("needs input");
  });

  it("PreToolUse(ExitPlanMode) then Stop gives waiting_input", () => {
    const mid = reduce(snap("working"), hook("PreToolUse", { tool_name: "ExitPlanMode" }));
    const next = reduce(mid, hook("Stop", {}, T0 + 2));
    expect(next.state).toBe("waiting_input");
    expect(next.state_detail).toBe("awaiting plan");
  });

  it("PreToolUse(Bash) then Stop gives idle", () => {
    const mid = reduce(snap("working"), hook("PreToolUse", { tool_name: "Bash" }));
    expect(mid.state_detail).toBe("tool:Bash");
    const next = reduce(mid, hook("Stop", {}, T0 + 2));
    expect(next.state).toBe("idle");
    expect(next.state_detail).toBeNull();
  });

  it("the last tool survives PostToolUse so Stop still sees it (cctop keeps last_tool)", () => {
    const a = reduce(snap("working"), hook("PreToolUse", { tool_name: "AskUserQuestion" }));
    const b = reduce(a, hook("PostToolUse", {}, T0 + 2));
    expect(b.state_detail).toBe("tool:AskUserQuestion");
    expect(reduce(b, hook("Stop", {}, T0 + 3)).state).toBe("waiting_input");
  });

  it("PreToolUse without a usable tool_name records tool:unknown", () => {
    expect(reduce(snap("working"), hook("PreToolUse", { tool_name: 3 })).state_detail).toBe(
      "tool:unknown",
    );
  });

  it("StopFailure gives error and records the error type", () => {
    const next = reduce(snap("working"), hook("StopFailure", { error: "rate_limit" }));
    expect(next.state).toBe("error");
    expect(next.state_detail).toBe("rate_limit");
    expect(reduce(snap("working"), hook("StopFailure", { error: 1 })).state_detail).toBe("error");
  });

  it("SessionEnd gives ended with ended_reason taken from reason", () => {
    const next = reduce(snap("idle"), hook("SessionEnd", { reason: "prompt_input_exit" }));
    expect(next.state).toBe("ended");
    expect(next.ended_reason).toBe("prompt_input_exit");
  });

  it("SessionEnd without a string reason records 'unknown'", () => {
    expect(reduce(snap("idle"), hook("SessionEnd", { reason: 7 })).ended_reason).toBe("unknown");
  });

  it("liveness alive:false gives exited; no change when already ended", () => {
    const dead = liveness({ pid: 4321, alive: false });
    const next = reduceLiveness(snap("working"), dead);
    expect(next.state).toBe("exited");
    expect(next.state_since).toBe(T0 + 1);
    expect(next.state_detail).toBe("process gone");
    const ended = snap("ended", { ended_reason: "clear" });
    expect(reduceLiveness(ended, dead)).toEqual({ ...ended, last_event_at: T0 + 1 });
  });

  it("liveness alive:false on an already exited session keeps state_since", () => {
    const prev = snap("exited", { state_since: 400 });
    expect(reduceLiveness(prev, liveness({ pid: 1, alive: false })).state_since).toBe(400);
  });

  it("liveness alive:true records the pid and nothing else", () => {
    const prev = snap("working");
    const next = reduceLiveness(prev, liveness({ pid: 4321, alive: true }));
    expect(next).toEqual({ ...prev, pid: 4321, last_event_at: T0 + 1 });
  });

  it.each([null, "x", { pid: -1, alive: true }, { pid: 1.5, alive: false }, { alive: false }])(
    "liveness payload %j that fails the schema only updates last_event_at",
    (payload) => {
      const prev = snap("working");
      expect(reduceLiveness(prev, liveness(payload))).toEqual({ ...prev, last_event_at: T0 + 1 });
    },
  );
});

describe("supersedeSamePid", () => {
  const incoming = { host: HOST, session_id: "new", pid: 77, ts: 5_000 };
  const old = snap("working", { session_id: "old", pid: 77 });

  it("ends the previous session on the same host and pid as superseded", () => {
    const [next] = supersedeSamePid([old], incoming);
    expect(next).toMatchObject({
      state: "ended",
      ended_reason: SUPERSEDED_REASON,
      state_since: 5_000,
      state_detail: "superseded",
      last_event_at: old.last_event_at,
    });
  });

  it("leaves other hosts, other pids, the incoming session and terminal sessions alone", () => {
    const sessions = [
      snap("working", { session_id: "h", pid: 77, host: "other-host" }),
      snap("working", { session_id: "p", pid: 78 }),
      snap("working", { session_id: "n", pid: null }),
      snap("working", { session_id: "new", pid: 77 }),
      snap("ended", { session_id: "e", pid: 77, ended_reason: "clear" }),
      snap("exited", { session_id: "x", pid: 77 }),
    ];
    const next = supersedeSamePid(sessions, incoming);
    expect(next).toEqual(sessions);
    expect(next).not.toBe(sessions);
  });

  it.each([0, -3, 1.5, Number.NaN])("ignores an invalid incoming pid %s", (pid) => {
    const sessions = [snap("working", { session_id: "a", pid: 0 })];
    expect(supersedeSamePid(sessions, { ...incoming, pid })).toEqual(sessions);
  });

  it("does not mutate its input and keeps order", () => {
    const sessions = deepFreeze([snap("idle", { session_id: "a", pid: 5 }), old]);
    const next = supersedeSamePid(sessions, incoming);
    expect(next.map((s) => s.session_id)).toEqual(["a", "old"]);
    expect(next[0]).toBe(sessions[0]);
  });
});

describe("R0.2 purity and totality", () => {
  const payloads: unknown[] = [
    {},
    null,
    "a string",
    42,
    [],
    { tool_name: 9, notification_type: [], reason: {}, error: false, prompt: 1, model: 2 },
    { tool_name: "AskUserQuestion", notification_type: "permission_prompt", agent_id: "a1" },
  ];
  const names: (string | undefined)[] = [
    ...HOOK_EVENTS,
    "NotARealEvent",
    "liveness_dead",
    "__proto__",
    "",
  ];

  it("every state x event x payload gives a valid, fresh snapshot with last_event_at = e.ts", () => {
    for (const state of SESSION_STATES) {
      for (const name of names) {
        for (const payload of payloads) {
          const tracking = {
            last_tool: "AskUserQuestion",
            permission: { tool: "Bash", agent_id: "a1" },
          };
          const prev = deepFreeze(snap(state, { state_detail: "tool:AskUserQuestion", tracking }));
          const e = deepFreeze(hook(name, payload, 7_777));
          const next = reduce(prev, e);
          expect(SESSION_STATES).toContain(next.state);
          expect(next.last_event_at).toBe(7_777);
          expect(next).not.toBe(prev);
          expect(reduce(prev, e)).toEqual(next);
        }
      }
    }
  });

  it("a missing hook_event_name behaves as an unknown event", () => {
    const prev = snap("working");
    expect(reduce(prev, hook(undefined))).toEqual({ ...prev, last_event_at: T0 + 1 });
  });

  it("unknown events return an equal snapshot with last_event_at updated", () => {
    const prev = snap("idle", { state_since: 321 });
    expect(reduce(prev, hook("Elicitation", { x: 1 }, 4_000))).toEqual({
      ...prev,
      last_event_at: 4_000,
    });
  });

  it("state_since changes only when state changes", () => {
    const working = snap("working", { state_since: 250 });
    expect(reduce(working, hook("PreToolUse", { tool_name: "Bash" })).state_since).toBe(250);
    expect(reduce(working, hook("Stop")).state_since).toBe(T0 + 1);
  });
});

describe("terminal states", () => {
  it("ended ignores every event except SessionStart (only last_event_at moves)", () => {
    const ended = snap("ended", { ended_reason: "clear", state_since: 100 });
    for (const name of HOOK_EVENTS.filter((n) => n !== "SessionStart")) {
      expect(reduce(ended, hook(name, { reason: "other", prompt: "p" }))).toEqual({
        ...ended,
        last_event_at: T0 + 1,
      });
    }
  });

  it("SessionStart with the same session_id revives ended (resume) and clears ended_reason", () => {
    const ended = snap("ended", { ended_reason: "clear" });
    const next = reduce(ended, hook("SessionStart", { source: "resume", model: "claude-x" }));
    expect(next.state).toBe("starting");
    expect(next.ended_reason).toBeNull();
    expect(next.state_detail).toBe("source:resume");
    expect(next.model).toEqual({ id: "claude-x", display_name: "claude-x" });
  });

  it("SessionStart on a live session keeps its state and an existing model with the same id", () => {
    const model = { id: "claude-x", display_name: "Claude X" };
    const prev = snap("working", { model });
    const next = reduce(prev, hook("SessionStart", { source: "compact", model: "claude-x" }));
    expect(next.state).toBe("working");
    expect(next.model).toBe(model);
    expect(reduce(prev, hook("SessionStart", {})).model).toBe(model);
  });

  it("SessionStart without a source clears the detail on revive", () => {
    expect(reduce(snap("exited"), hook("SessionStart", {})).state_detail).toBeNull();
  });

  it("a late hook after exited revives the session (the process is alive)", () => {
    const next = reduce(
      snap("exited", { state_since: 100 }),
      hook("PreToolUse", { tool_name: "Bash" }),
    );
    expect(next.state).toBe("working");
    expect(next.state_since).toBe(T0 + 1);
  });

  it("an event with no row leaves exited as exited", () => {
    expect(reduce(snap("exited"), hook("TaskCreated", { subject: "x" })).state).toBe("exited");
  });

  it("SessionEnd after exited ends the session", () => {
    expect(reduce(snap("exited"), hook("SessionEnd", { reason: "logout" })).state).toBe("ended");
  });
});

describe("subagent envelopes (agent_id)", () => {
  const sub = { agent_id: "agent-1" };

  it("never reach idle, waiting_input or ended", () => {
    const working = snap("working", {
      state_detail: "tool:AskUserQuestion",
      tracking: { last_tool: "ExitPlanMode", permission: null },
    });
    for (const name of ["Stop", "SubagentStop", "SessionEnd"]) {
      const next = reduce(working, hook(name, { reason: "other" }, T0 + 1, sub));
      expect(next.state).toBe("working");
      expect(next.ended_reason).toBeNull();
    }
  });

  it("do not write the main thread's last_assistant_message", () => {
    const next = reduce(
      snap("working"),
      hook("Stop", { last_assistant_message: "sub" }, T0 + 1, sub),
    );
    expect(next.last_assistant_message).toBeNull();
  });

  it("PermissionRequest and permission Notification still reach waiting_permission", () => {
    expect(reduce(snap("working"), hook("PermissionRequest", {}, T0 + 1, sub)).state).toBe(
      "waiting_permission",
    );
    const n = hook("Notification", { notification_type: "permission_prompt" }, T0 + 1, sub);
    expect(reduce(snap("working"), n).state).toBe("waiting_permission");
  });

  it("an empty agent_id is treated as the main thread", () => {
    expect(reduce(snap("working"), hook("Stop", {}, T0 + 1, { agent_id: "" })).state).toBe("idle");
  });
});

describe("field updates", () => {
  it("UserPromptSubmit records last_prompt (string only) and clears the detail", () => {
    const prev = snap("idle", { state_detail: "needs input" });
    const next = reduce(prev, hook("UserPromptSubmit", { prompt: "fix it" }));
    expect(next).toMatchObject({ state: "working", last_prompt: "fix it", state_detail: null });
    expect(reduce(next, hook("UserPromptSubmit", { prompt: 5 })).last_prompt).toBe("fix it");
  });

  it("Stop records last_assistant_message when it is a string", () => {
    const next = reduce(snap("working"), hook("Stop", { last_assistant_message: "done" }));
    expect(next.last_assistant_message).toBe("done");
    expect(reduce(next, hook("Stop", { last_assistant_message: 3 })).last_assistant_message).toBe(
      "done",
    );
  });

  it("PostCompact mid-turn (starting, working) goes to working; compactions + 1", () => {
    for (const state of ["starting", "working"] as const) {
      const next = reduce(snap(state, { compactions: 2 }), hook("PostCompact"));
      expect(next).toMatchObject({ state: "working", compactions: 3, state_detail: null });
    }
  });

  it("PermissionDenied goes back to working", () => {
    expect(reduce(snap("waiting_permission"), hook("PermissionDenied")).state).toBe("working");
  });

  it("SubagentStart adds a row once; SubagentStop closes it once", () => {
    const start = hook("SubagentStart", { agent_id: "a1", agent_type: "Explore" }, 2_000);
    const one = reduce(snap("working"), start);
    expect(one.subagents).toEqual([
      {
        agent_id: "a1",
        agent_type: "Explore",
        started_at: 2_000,
        ended_at: null,
        tokens: null,
        context_window: null,
        model: null,
      },
    ]);
    expect(reduce(one, start).subagents).toHaveLength(1);
    const stopped = reduce(one, hook("SubagentStop", { agent_id: "a1" }, 3_000));
    expect(stopped.subagents[0]?.ended_at).toBe(3_000);
    expect(reduce(stopped, hook("SubagentStop", { agent_id: "a1" }, 4_000)).subagents).toEqual(
      stopped.subagents,
    );
    expect(stopped.state).toBe("working");
  });

  it("SubagentStart without ids or type is tolerated; SubagentStop of an unknown id is ignored", () => {
    expect(reduce(snap("working"), hook("SubagentStart", {})).subagents).toEqual([]);
    const typeless = reduce(snap("working"), hook("SubagentStart", { agent_id: "z" }));
    expect(typeless.subagents[0]?.agent_type).toBe("unknown");
    const other = reduce(typeless, hook("SubagentStop", { agent_id: "other" }));
    expect(other.subagents).toEqual(typeless.subagents);
    const two = reduce(typeless, hook("SubagentStart", { agent_id: "y" }));
    const closed = reduce(two, hook("SubagentStop", { agent_id: "z" }, 9_000));
    expect(closed.subagents.map((a) => a.ended_at)).toEqual([9_000, null]);
  });
});

describe("provisional behavior (fixtures pending)", () => {
  it.each(["PostToolUseFailure", "TaskCreated", "TaskCompleted", "PreCompact"])(
    "%s leaves state unchanged and updates last_event_at",
    (name) => {
      const prev = snap("working", { state_since: 300 });
      const next = reduce(prev, hook(name, { subject: "s", tool_response: {}, error: "x" }));
      expect(next).toEqual({ ...prev, last_event_at: T0 + 1 });
    },
  );

  it("PostToolUse moves to working without reading tool_response", () => {
    const next = reduce(snap("idle"), hook("PostToolUse", { tool_response: { is_error: true } }));
    expect(next.state).toBe("working");
  });

  it("every provisional entry names a registered hook event", () => {
    for (const p of PROVISIONAL_BEHAVIOR) expect(HOOK_EVENTS).toContain(p.event);
  });

  // TODO(fixture): PostToolUseFailure payload fields are unverified. Intended: a payload that marks
  // an API error moves the session to error (state_detail = error type); a plain tool failure moves
  // it to working.
  it.skip("PostToolUseFailure with api error gives error, plain tool failure gives working", () => {
    expect.fail("TODO(fixture): write once a PostToolUseFailure fixture exists");
  });

  // TODO(fixture): TaskCreated payload unverified. Intended: tasks.total + 1, tasks.last_subject
  // from the payload subject; state unchanged.
  it.skip("TaskCreated increments tasks.total and records last_subject", () => {
    expect.fail("TODO(fixture): write once a TaskCreated fixture exists");
  });

  // TODO(fixture): TaskCompleted payload unverified. Intended: tasks.completed + 1,
  // tasks.last_subject from the payload subject; state unchanged.
  it.skip("TaskCompleted increments tasks.completed and records last_subject", () => {
    expect.fail("TODO(fixture): write once a TaskCompleted fixture exists");
  });

  // TODO(fixture): PreCompact payload unverified. Intended: read the compaction trigger (manual or
  // auto) into state_detail; state unchanged.
  it.skip("PreCompact records the compaction trigger in state_detail", () => {
    expect.fail("TODO(fixture): write once a PreCompact fixture exists");
  });

  // TODO(fixture): a subagent's StopFailure is unconfirmed. Today it moves the session to error;
  // intended: confirm against a captured subagent failure whether the session should move at all.
  it.skip("a subagent StopFailure moves (or does not move) the session to error", () => {
    expect.fail("TODO(fixture): write once a subagent StopFailure fixture exists");
  });

  // TODO(fixture): PostToolUse tool_response unverified. Intended: detect an interrupted or failed
  // result from tool_response instead of treating every PostToolUse as success.
  it.skip("PostToolUse reads tool_response to detect an interrupted result", () => {
    expect.fail("TODO(fixture): write once a PostToolUse fixture with tool_response exists");
  });
});

describe("timelines", () => {
  type Step = { name: string; payload: unknown; ts: number; state: string; detail: string | null };

  // SYNTHETIC sequence (inline, documented fields only). Not a captured session.
  it("synthetic session: start, prompt, tool, permission, post-tool, stop, end", () => {
    const steps: Step[] = [
      {
        name: "SessionStart",
        payload: { source: "startup" },
        ts: 1_100,
        state: "starting",
        detail: "source:startup",
      },
      {
        name: "UserPromptSubmit",
        payload: { prompt: "hi" },
        ts: 1_200,
        state: "working",
        detail: null,
      },
      {
        name: "PreToolUse",
        payload: { tool_name: "Bash" },
        ts: 1_300,
        state: "working",
        detail: "tool:Bash",
      },
      {
        name: "PermissionRequest",
        payload: { tool_name: "Bash" },
        ts: 1_400,
        state: "waiting_permission",
        detail: "tool:Bash",
      },
      { name: "PostToolUse", payload: {}, ts: 1_500, state: "working", detail: "tool:Bash" },
      {
        name: "Stop",
        payload: { last_assistant_message: "ok" },
        ts: 1_600,
        state: "idle",
        detail: null,
      },
      { name: "SessionEnd", payload: { reason: "other" }, ts: 1_700, state: "ended", detail: null },
    ];
    let current: SessionSnapshot = snap("starting");
    const seen: { state: string; detail: string | null; since: number }[] = [];
    for (const s of steps) {
      current = reduce(current, hook(s.name, s.payload, s.ts));
      seen.push({ state: current.state, detail: current.state_detail, since: current.state_since });
    }
    expect(seen).toEqual([
      { state: "starting", detail: "source:startup", since: T0 },
      { state: "working", detail: null, since: 1_200 },
      { state: "working", detail: "tool:Bash", since: 1_200 },
      { state: "waiting_permission", detail: "tool:Bash", since: 1_400 },
      { state: "working", detail: "tool:Bash", since: 1_500 },
      { state: "idle", detail: null, since: 1_600 },
      { state: "ended", detail: null, since: 1_700 },
    ]);
    expect(current).toMatchObject({
      last_prompt: "hi",
      last_assistant_message: "ok",
      ended_reason: "other",
      last_event_at: 1_700,
    });
  });

  // TODO(fixture): S0b supplies a real session's fixture sequence under packages/contract/fixtures/.
  // Intended: wrap each fixture as an envelope in capture order, reduce, and assert the hand-verified
  // state timeline (R0.2).
  it.skip("golden timeline from a real session's fixtures", () => {
    expect.fail("TODO(fixture): write the golden timeline once S0b captures a real session");
  });
});

describe("registries", () => {
  it("HOOK_EVENTS matches scripts/lib/hook-events.mjs", async () => {
    const path = join(import.meta.dirname, "..", "..", "..", "scripts", "lib", "hook-events.mjs");
    const mod = (await import(pathToFileURL(path).href)) as { HOOK_EVENTS: readonly string[] };
    expect([...HOOK_EVENTS]).toEqual([...mod.HOOK_EVENTS]);
    expect(Object.isFrozen(HOOK_EVENTS)).toBe(true);
  });

  it("the transition table is deeply frozen and only targets known states", () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    for (const t of TRANSITIONS) {
      expect(Object.isFrozen(t) && Object.isFrozen(t.from) && Object.isFrozen(t.guards)).toBe(true);
      expect(SESSION_STATES).toContain(t.to);
    }
  });
});
