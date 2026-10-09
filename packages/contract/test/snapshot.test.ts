import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/snapshot";
import { SESSION_STATES } from "../src/state";

const input = { session_id: "s1", host: "h1", cwd: "<HOME>/p", ts: 1234 };

describe("createSnapshot", () => {
  it("returns a fully populated starting snapshot", () => {
    const snap = createSnapshot(input);
    expect(snap.state).toBe("starting");
    expect(snap).toMatchObject({
      session_id: "s1",
      host: "h1",
      cwd: "<HOME>/p",
      state_since: 1234,
      started_at: 1234,
      last_event_at: 1234,
      compactions: 0,
      subagents: [],
      prompt_cache: null,
      tasks: { total: 0, completed: 0, last_subject: null },
      rate_limits: { five_hour: null, seven_day: null, captured_at: null },
      tracking: { last_tool: null, permission: null },
    });
    expect(Object.keys(snap)).toHaveLength(25);
  });

  it("returns a new object (and new nested objects) every call", () => {
    const a = createSnapshot(input);
    const b = createSnapshot(input);
    expect(a).not.toBe(b);
    expect(a.subagents).not.toBe(b.subagents);
    expect(a.context).not.toBe(b.context);
    expect(a.tracking).not.toBe(b.tracking);
    expect(a).toEqual(b);
  });
});

describe("SESSION_STATES", () => {
  it("lists the eight states of architecture 3.2", () => {
    expect([...SESSION_STATES]).toEqual([
      "starting",
      "working",
      "waiting_permission",
      "waiting_input",
      "idle",
      "error",
      "ended",
      "exited",
    ]);
  });
});
