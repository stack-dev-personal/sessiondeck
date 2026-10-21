import type { Envelope } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import { createBoardStore } from "./board";
import { HISTORY_CAPS, pushCapped } from "./history";

function hook(session: string, name: string, ts: number): Envelope {
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
    payload: { session_id: session, cwd: "/p", hook_event_name: name },
  };
}

function statusline(session: string, ts: number, pct: number): Envelope {
  return {
    v: 1,
    id: "01HZX3K9QJ5V8M2N4P6R7S8T9W",
    kind: "statusline",
    host: "h1",
    os: "linux",
    session_id: session,
    ts,
    seq: ts,
    payload: { session_id: session, cwd: "/p", context_window: { used_percentage: pct } },
  } as Envelope;
}

describe("pushCapped", () => {
  it("drops the oldest at the cap and never mutates the input", () => {
    const a = [1, 2, 3];
    expect(pushCapped(a, 4, 3)).toEqual([2, 3, 4]);
    expect(pushCapped(a, 4, 4)).toEqual([1, 2, 3, 4]);
    expect(a).toEqual([1, 2, 3]);
  });
});

describe("per-session history", () => {
  const sync = createBoardStore((cb) => cb());

  it("records the first state, then only real transitions; the 21st drops the oldest", () => {
    const store = createBoardStore((cb) => cb());
    store.getState().enqueue(hook("a", "SessionStart", 1));
    for (let i = 0; i < 25; i++) {
      store.getState().enqueue(hook("a", i % 2 === 0 ? "UserPromptSubmit" : "Stop", 100 + i));
    }
    const t = store.getState().history["a"]!.transitions;
    expect(t).toHaveLength(HISTORY_CAPS.transitions);
    expect(t[t.length - 1]!.ts).toBe(124);
    expect(t[0]!.ts).toBe(105);
    // repeated same state adds nothing
    store.getState().enqueue(hook("a", "Stop", 200));
    store.getState().enqueue(hook("a", "Stop", 201));
    expect(store.getState().history["a"]!.transitions.length).toBe(HISTORY_CAPS.transitions);
    expect(sync.getState().history).toEqual({});
  });

  it("caps samples (120) and the envelope tail (50)", () => {
    const store = createBoardStore((cb) => cb());
    for (let i = 0; i < 130; i++) store.getState().enqueue(statusline("a", 1000 + i, i % 100));
    const h = store.getState().history["a"]!;
    expect(h.samples).toHaveLength(HISTORY_CAPS.samples);
    expect(h.samples[h.samples.length - 1]).toEqual({ ts: 1129, pct: 29 });
    expect(h.tail).toHaveLength(HISTORY_CAPS.tail);
    expect(h.tail[h.tail.length - 1]!.ts).toBe(1129);
  });

  it("coalesces: one set() per frame carries the history too", () => {
    const frames: (() => void)[] = [];
    const store = createBoardStore((cb) => frames.push(cb));
    let sets = 0;
    store.subscribe(() => sets++);
    for (let i = 0; i < 10; i++) store.getState().enqueue(hook("a", "UserPromptSubmit", i));
    expect(store.getState().history).toEqual({});
    frames[0]!();
    expect(sets).toBe(1);
    expect(store.getState().history["a"]!.tail).toHaveLength(10);
  });

  it("replaceAll clears history with the other maps", () => {
    const store = createBoardStore((cb) => cb());
    store.getState().enqueue(statusline("a", 1, 10));
    expect(store.getState().history["a"]).toBeDefined();
    store.getState().replaceAll([]);
    expect(store.getState().history).toEqual({});
    expect(store.getState().sessions).toEqual({});
  });
});
