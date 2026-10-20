import { SESSION_STATES } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardStore } from "../store/board";
import { playTimeline } from "./player";
import { startMock } from "./start";
import { buildMockTimeline } from "./timeline";

const NOW = 1_792_400_000_000;

describe("mock replay", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used in mock mode");
    });
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("WebSocket used in mock mode");
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds a strictly ordered, schema-shaped timeline", () => {
    const tl = buildMockTimeline(NOW);
    expect(tl.length).toBeGreaterThan(500);
    for (let i = 1; i < tl.length; i++) expect(tl[i]!.ts).toBeGreaterThan(tl[i - 1]!.ts);
    expect(new Set(tl.map((e) => e.host))).toEqual(new Set(["stack-lap", "stack-box"]));
    expect(new Set(tl.map((e) => e.kind))).toEqual(new Set(["hook", "liveness", "statusline"]));
  });

  it("runs to completion and yields many states on 2 hosts with no network", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    const store = createBoardStore();
    const onDone = vi.fn();
    playTimeline(buildMockTimeline(NOW), store.getState().enqueue, { onDone });
    expect(() => vi.advanceTimersByTime(10 * 60_000)).not.toThrow();
    expect(onDone).toHaveBeenCalledTimes(1);
    const list = Object.values(store.getState().sessions);
    expect(list).toHaveLength(8);
    expect(new Set(list.map((s) => s.host)).size).toBe(2);
    const states = new Set(list.map((s) => s.state));
    expect(states).toEqual(
      new Set([
        "waiting_permission",
        "idle",
        "working",
        "ended",
        "starting",
        "waiting_input",
        "error",
        "exited",
      ]),
    );
    for (const s of states) expect(SESSION_STATES).toContain(s);
    // statusLine data landed: context and 5h window populated for a live session
    const withCtx = list.filter((s) => s.context.used_pct !== null);
    expect(withCtx.length).toBeGreaterThanOrEqual(3);
    expect(list.some((s) => s.rate_limits.five_hour?.used_pct != null)).toBe(true);
    expect(list.every((s) => s.session_id.startsWith("mock-"))).toBe(true);
  });

  it("startMock marks the connection as mock and plays through the store", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    const store = createBoardStore();
    const cancel = startMock(store);
    expect(store.getState().connection).toBe("mock");
    vi.advanceTimersByTime(1000);
    expect(Object.keys(store.getState().sessions).length).toBeGreaterThan(0);
    cancel();
  });

  it("cancel stops delivery", () => {
    vi.useFakeTimers();
    const got: number[] = [];
    const cancel = playTimeline(buildMockTimeline(NOW), (e) => got.push(e.seq));
    cancel();
    const n = got.length;
    vi.advanceTimersByTime(5000);
    expect(got).toHaveLength(n);
  });
});
