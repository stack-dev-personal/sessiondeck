import type { Envelope } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardStore } from "./board";

function hook(session: string, name: string, ts: number, payload: object = {}): Envelope {
  return {
    v: 1,
    id: "01HZX3K9QJ5V8M2N4P6R7S8T9W",
    kind: "hook",
    host: "h1",
    os: "linux",
    session_id: session,
    hook_event_name: name,
    ts,
    seq: ts,
    payload: { session_id: session, cwd: "/p", hook_event_name: name, ...payload },
  };
}

describe("board store rAF coalescing", () => {
  let frames: (() => void)[];
  const raf = (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  };
  beforeEach(() => {
    frames = [];
  });
  afterEach(() => vi.useRealTimers());

  it("applies nothing until the frame, then all queued updates in one set()", () => {
    const store = createBoardStore(raf);
    const renders = vi.fn();
    store.subscribe(renders);
    for (let i = 0; i < 15; i++) store.getState().enqueue(hook("a", "UserPromptSubmit", 1000 + i));
    store.getState().enqueue(hook("b", "SessionStart", 2000));
    expect(frames).toHaveLength(1);
    expect(store.getState().sessions).toEqual({});
    expect(renders).not.toHaveBeenCalled();
    frames.shift()!();
    expect(renders).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.getState().sessions).sort()).toEqual(["a", "b"]);
    expect(store.getState().sessions["a"]!.state).toBe("working");
    expect(store.getState().sessions["a"]!.last_event_at).toBe(1014);
  });

  it("schedules a new frame for updates after a flush", () => {
    const store = createBoardStore(raf);
    store.getState().enqueue(hook("a", "SessionStart", 1));
    frames.shift()!();
    store.getState().enqueue(hook("a", "UserPromptSubmit", 2));
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(store.getState().sessions["a"]!.state).toBe("working");
  });

  it("works with fake timers driving the default requestAnimationFrame", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const store = createBoardStore();
    store.getState().enqueue(hook("a", "SessionStart", 1));
    store.getState().enqueue(hook("a", "UserPromptSubmit", 2));
    expect(store.getState().sessions).toEqual({});
    vi.advanceTimersByTime(20);
    expect(store.getState().sessions["a"]!.state).toBe("working");
  });

  it("ignores envelopes without a session_id and keeps untouched sessions identical", () => {
    const store = createBoardStore(raf);
    store.getState().enqueue(hook("a", "SessionStart", 1));
    frames.shift()!();
    const a = store.getState().sessions["a"];
    store.getState().enqueue({ ...hook("x", "SessionStart", 2), kind: "probe", session_id: null });
    store.getState().enqueue(hook("b", "SessionStart", 3));
    frames.shift()!();
    expect(store.getState().sessions["a"]).toBe(a);
    expect(Object.keys(store.getState().sessions).sort()).toEqual(["a", "b"]);
  });
});
