import { createSnapshot, type Envelope, type SessionSnapshot } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import { ACTIVITY_CAP, appendRows, draftRows } from "./activity";
import { createBoardStore } from "./board";

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  ...createSnapshot({ session_id: "a", host: "h", cwd: "/w/a", ts: 1 }),
  ...over,
});

describe("draftRows (R6.4)", () => {
  it("first sight gives a state row", () => {
    expect(draftRows(undefined, snap()).map((d) => d.kind)).toEqual(["state"]);
  });
  it("reports the changes: state, tool, usage; nothing when nothing changed", () => {
    const a = snap({ state: "idle" });
    const b = snap({
      state: "working",
      tracking: { last_tool: "Bash", permission: null },
      context: { used_pct: 41.6, window: null, input: null, output: null },
      cost: { usd: 1.234, duration_ms: null, lines_added: null, lines_removed: null },
    });
    const rows = draftRows(a, b);
    expect(rows.map((d) => d.kind)).toEqual(["state", "tool", "usage"]);
    expect(rows[2]!.text).toBe("ctx 42% · $1.23");
    expect(draftRows(b, b)).toEqual([]);
    expect(draftRows(b, b, "PostToolUse")).toEqual([{ kind: "event", text: "PostToolUse" }]);
  });
  it("clips long untrusted text", () => {
    const rows = draftRows(snap(), snap({ last_prompt: "x".repeat(5000) }));
    expect(rows.find((r) => r.kind === "prompt")!.text.length).toBeLessThanOrEqual(160);
  });
});

describe("activity ring buffer (R6.4)", () => {
  it("never holds more than the cap, drops the oldest, keeps n monotonic, never mutates", () => {
    let log = appendRows(undefined, 1, [{ kind: "event", text: "first" }]);
    const first = log;
    for (let i = 0; i < ACTIVITY_CAP + 200; i++)
      log = appendRows(log, 2 + i, [{ kind: "event", text: `r${i}` }]);
    expect(log.rows).toHaveLength(ACTIVITY_CAP);
    expect(log.total).toBe(ACTIVITY_CAP + 201);
    expect(log.rows[0]!.n).toBe(log.total - ACTIVITY_CAP);
    expect(log.rows[ACTIVITY_CAP - 1]!.text).toBe(`r${ACTIVITY_CAP + 199}`);
    expect(first.rows).toHaveLength(1);
    // A burst bigger than the cap in one append is cut to the cap as well.
    const big = appendRows(
      undefined,
      1,
      Array.from({ length: 900 }, (_, i) => ({ kind: "event" as const, text: `${i}` })),
    );
    expect(big.rows).toHaveLength(ACTIVITY_CAP);
    expect(big.rows[0]!.text).toBe("400");
  });
  it("an empty append returns the same object (no render for nothing)", () => {
    const log = appendRows(undefined, 1, [{ kind: "event", text: "x" }]);
    expect(appendRows(log, 2, [])).toBe(log);
  });
});

function hook(session: string, name: string, ts: number): Envelope {
  return {
    v: 1,
    id: "01HZX3K9QJ5V8M2N4P6R7S8T9W",
    kind: "hook",
    host: "h",
    os: "linux",
    session_id: session,
    hook_event_name: name,
    ts,
    seq: ts,
    payload: { session_id: session, cwd: "/p", hook_event_name: name },
  };
}

describe("resync seeds each session's log (R6.4)", () => {
  it("replaceAll gives every session a first row with its current state", () => {
    const store = createBoardStore(() => 0);
    store.getState().replaceAll([snap({ state: "working", last_event_at: 7 })]);
    const rows = store.getState().activity["a"]!.rows;
    expect(rows.map((r) => r.kind)).toEqual(["state"]);
    expect(rows[0]!.ts).toBe(7);
  });
  it("a resync keeps the log of a known session and adds a state row only on a change", () => {
    const store = createBoardStore(() => 0);
    store.getState().replaceAll([snap({ state: "working", last_event_at: 7 })]);
    for (let i = 0; i < 5; i++)
      store.setState((st) => ({
        activity: {
          ...st.activity,
          a: appendRows(st.activity["a"], 8 + i, [{ kind: "event", text: `e${i}` }]),
        },
      }));
    const before = store.getState().activity["a"]!;
    expect(before.rows).toHaveLength(6);
    store.getState().replaceAll([snap({ state: "working", last_event_at: 20 })]);
    expect(store.getState().activity["a"]).toBe(before);
    store.getState().replaceAll([snap({ state: "idle", last_event_at: 30 })]);
    const after = store.getState().activity["a"]!;
    expect(after.rows).toHaveLength(7);
    expect(after.rows[6]!.kind).toBe("state");
    expect(after.rows[0]).toEqual(before.rows[0]);
    // A session that left the list is gone; a new one opens on its state.
    store.getState().replaceAll([snap({ session_id: "b", state: "idle" })]);
    expect(Object.keys(store.getState().activity)).toEqual(["b"]);
  });
});

describe("board store feeds the ring in the same coalesced commit (R6.4)", () => {
  it("one set() per frame carries sessions and activity; other sessions keep their log object", () => {
    const frames: (() => void)[] = [];
    const store = createBoardStore((cb) => frames.push(cb));
    let commits = 0;
    store.subscribe(() => commits++);
    for (let i = 0; i < 700; i++) store.getState().enqueue(hook("a", "PostToolUse", i + 1));
    store.getState().enqueue(hook("b", "SessionStart", 5000));
    frames.shift()!();
    expect(commits).toBe(1);
    const { activity } = store.getState();
    expect(activity["a"]!.rows).toHaveLength(ACTIVITY_CAP);
    expect(activity["b"]!.rows.length).toBeGreaterThan(0);
    const b = activity["b"];
    store.getState().enqueue(hook("a", "PostToolUse", 9000));
    frames.shift()!();
    expect(store.getState().activity["b"]).toBe(b);
    expect(store.getState().activity["a"]!.total).toBeGreaterThan(700);
  });
  it("hub snapshot deltas also produce rows", () => {
    const frames: (() => void)[] = [];
    const store = createBoardStore((cb) => frames.push(cb));
    store.getState().enqueueSnapshot(snap({ state: "working" }));
    frames.shift()!();
    store.getState().enqueueSnapshot(snap({ state: "idle", last_event_at: 5 }));
    frames.shift()!();
    expect(store.getState().activity["a"]!.rows.map((r) => r.kind)).toEqual(["state", "state"]);
  });
});
