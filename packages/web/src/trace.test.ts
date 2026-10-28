// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  attributeDrops,
  markedWindow,
  longTaskDetails,
  mainThreadBusy,
  pipelineFrames,
  type TraceEvent,
} from "../e2e/load/trace";
import { judgeGate, type GateWindow } from "../e2e/load/gate";

const meta: TraceEvent = {
  ph: "M",
  name: "thread_name",
  pid: 1,
  tid: 2,
  ts: 0,
  args: { name: "CrRendererMain" },
};
const x = (name: string, ts: number, dur: number): TraceEvent => ({
  ph: "X",
  name,
  pid: 1,
  tid: 2,
  ts,
  dur,
});

describe("R3.6 trace analysis", () => {
  it("accepts both top-level task names and merges nested tasks", () => {
    const ev = [
      meta,
      x("RunTask", 0, 1000),
      x("ThreadControllerImpl::RunTask", 200, 300), // nested: counts once
      x("ThreadControllerImpl::RunTask", 2000, 1000),
    ];
    const r = mainThreadBusy(ev, 10_000);
    expect(r.taskCount).toBe(3);
    expect(r.busyPct).toBe(20);
  });

  it("limits script time to the busiest main thread, clips to the window, reports GC inside", () => {
    const meta2: TraceEvent = { ...meta, tid: 9 };
    const other = (name: string, ts: number, dur: number): TraceEvent => ({
      ...x(name, ts, dur),
      tid: 9,
    });
    const ev = [
      meta,
      meta2,
      x("RunTask", 0, 9000),
      x("TimerFire", 100, 5000),
      x("MajorGC", 200, 3000),
      x("TimerFire", 20_000, 50_000), // after the 10 ms window: ignored
      other("RunTask", 0, 100),
      other("TimerFire", 0, 90_000), // quiet thread: ignored
    ];
    const r = mainThreadBusy(ev, 10_000);
    expect(r.maxScriptMs).toBe(5);
    expect(r.maxScriptGcMs).toBe(3);
  });

  it("reports zero counted tasks for an unrecognised trace instead of failing open", () => {
    const r = mainThreadBusy([meta, x("SomethingElse", 0, 5000)], 10_000);
    expect(r.taskCount).toBe(0);
    expect(r.mainThreads).toBe(1);
  });

  it("handles more than 200k tasks without a spread overflow", () => {
    const ev: TraceEvent[] = [meta];
    for (let i = 0; i < 200_000; i++) ev.push(x("RunTask", i * 10, 5));
    expect(mainThreadBusy(ev, 2_000_000).taskCount).toBe(200_000);
  });

  it("names the events inside a long task", () => {
    const ev = [
      meta,
      x("RunTask", 0, 60_000),
      x("Paint", 100, 40_000),
      x("Layerize", 41_000, 10_000),
      x("RunTask", 100_000, 1_000),
    ];
    const d = longTaskDetails(ev);
    expect(d).toHaveLength(1);
    expect(d[0]!.durMs).toBe(60);
    expect(d[0]!.children.map((c) => c.name)).toEqual(["Paint", "Layerize"]);
  });

  it("lists a nested long task once", () => {
    const ev = [
      meta,
      x("RunTask", 0, 60_000),
      x("ThreadControllerImpl::RunTask", 10, 59_000),
      x("Paint", 100, 40_000),
    ];
    expect(longTaskDetails(ev)).toHaveLength(1);
  });
});

describe("pipelineFrames (R6.4)", () => {
  const pr = (state: string, key = "frame_reporter", extra = {}): TraceEvent => ({
    ph: "b",
    name: "PipelineReporter",
    pid: 1,
    tid: 3,
    ts: 1,
    args: { [key]: { state, ...extra } },
  });
  it("counts frames by state and dropped ones with their reason", () => {
    const ev: TraceEvent[] = [
      pr("STATE_PRESENTED_ALL"),
      pr("STATE_PRESENTED_PARTIAL"),
      pr("STATE_DROPPED", "frame_reporter", { reason: "REASON_MAIN_THREAD" }),
      pr("STATE_DROPPED", "chrome_frame_reporter"),
      { ph: "e", name: "PipelineReporter", pid: 1, tid: 3, ts: 2 },
      {
        ph: "X",
        name: "Other",
        pid: 1,
        tid: 3,
        ts: 3,
        args: { frame_reporter: { state: "STATE_DROPPED" } },
      },
    ];
    const r = pipelineFrames(ev);
    expect(r.total).toBe(4);
    expect(r.dropped + r.droppedAtEdge).toBe(2);
    expect(r.dropReasons).toEqual({ REASON_MAIN_THREAD: 1, unknown: 1 });
  });
  it("a dropped frame at the very start or end of the trace is counted apart", () => {
    const at = (ts: number, state: string): TraceEvent => ({ ...pr(state), ts });
    const ev = [
      at(1_000_000, "STATE_DROPPED"),
      at(1_050_000, "STATE_PRESENTED_ALL"),
      at(2_000_000, "STATE_DROPPED"),
      at(3_000_000, "STATE_PRESENTED_ALL"),
      at(3_020_000, "STATE_DROPPED"),
    ];
    const r = pipelineFrames(ev);
    expect(r.dropped).toBe(1);
    expect(r.droppedAtEdge).toBe(2);
  });
  it("an empty trace reports zero frames, so a caller can refuse to pass on no evidence", () => {
    expect(pipelineFrames([]).total).toBe(0);
  });
});

describe("attributeDrops (R6.4)", () => {
  const V = 16_700;
  const ts = (message: string, at: number): TraceEvent => ({
    ph: "I",
    name: "TimeStamp",
    pid: 1,
    tid: 2,
    ts: at,
    args: { data: { message } },
  });
  /** `skip` frame indexes are never fired (a gap of two vsyncs around them). */
  const frames = (n: number, skip: number[] = []): TraceEvent[] =>
    Array.from({ length: n }, (_, i) => i)
      .filter((i) => !skip.includes(i))
      .map((i) => x("FireAnimationFrame", 1_000_000 + i * V, 200));
  const pipe = (state: string, at: number, len: number, id: string): TraceEvent[] => [
    {
      ph: "b",
      name: "PipelineReporter",
      pid: 1,
      tid: 3,
      ts: at,
      args: { frame_reporter: { state } },
      id2: { local: id },
    } as TraceEvent,
    { ph: "e", name: "PipelineReporter", pid: 1, tid: 3, ts: at + len, id2: { local: id } } as TraceEvent,
  ];

  it("a gap filled with 10 ms of script is the app's; an idle gap is the host's", () => {
    const ev = [
      meta,
      ...frames(60, [20, 40]),
      x("FunctionCall", 1_000_000 + 19 * V + 300, 10_000), // inside the gap before frame 21
    ];
    const r = attributeDrops(ev);
    expect(r.rafGaps).toBe(2);
    expect(r.appDrops).toBe(1);
    expect(r.otherDrops).toBe(1);
    const app = r.drops.find((d) => d.app)!;
    expect(app.workMs).toBeGreaterThanOrEqual(10);
    expect(app.byKind.script).toBeGreaterThanOrEqual(10);
    expect(r.maxOtherGapVsyncs).toBeCloseTo(2, 1);
  });

  it("sums layout, paint and GC together and counts nested events once", () => {
    const base = 1_000_000 + 19 * V;
    const ev = [
      meta,
      ...frames(60, [20]),
      x("UpdateLayoutTree", base + 300, 3000),
      x("LocalFrameView::RunPaintLifecyclePhase", base + 4000, 3000),
      x("Paint", base + 4500, 1000), // nested in the paint phase: no extra time
      x("MinorGC", base + 8000, 2000),
    ];
    const r = attributeDrops(ev);
    expect(r.drops).toHaveLength(1);
    expect(r.drops[0]!.workMs).toBeGreaterThanOrEqual(8);
    expect(r.drops[0]!.workMs).toBeLessThan(8.5);
    expect(r.drops[0]!.app).toBe(true);
    expect(r.drops[0]!.byKind).toMatchObject({ layout: 3, paint: 3, gc: 2 });
  });

  it("7 ms of work in the gap stays under the 8 ms line", () => {
    const ev = [meta, ...frames(60, [20]), x("FunctionCall", 1_000_000 + 19 * V + 300, 7000)];
    const r = attributeDrops(ev);
    expect(r.rafGaps).toBe(1);
    expect(r.appDrops).toBe(0);
  });

  it("attributes STATE_DROPPED frames by main-thread work inside the frame", () => {
    const ev = [
      meta,
      ...frames(60),
      ...pipe("STATE_PRESENTED_ALL", 1_100_000, V, "0x1"),
      ...pipe("STATE_DROPPED", 1_200_000, V, "0x2"), // idle main thread: the host's
      ...pipe("STATE_DROPPED", 1_400_000, V, "0x3"), // 9 ms of paint inside: the app's
      x("LocalFrameView::RunPaintLifecyclePhase", 1_401_000, 9000),
    ];
    const r = attributeDrops(ev);
    expect(r.compositorFrames).toBe(3);
    expect(r.compositorDrops).toBe(2);
    expect(r.appDrops).toBe(1);
    expect(r.otherDrops).toBe(1);
  });

  it("only looks inside the marked window", () => {
    const ev = [
      meta,
      ts("r64-start", 1_000_000 + 10 * V),
      ...frames(60, [5, 40]), // the gap at 5 is before the window
      ts("r64-end", 1_000_000 + 55 * V),
      ...pipe("STATE_DROPPED", 1_000_000 + 2 * V, V, "0x9"), // before the window
    ];
    const w = markedWindow(ev);
    expect(w).toEqual([1_000_000 + 10 * V, 1_000_000 + 55 * V]);
    const r = attributeDrops(ev, { window: w });
    expect(r.rafGaps).toBe(1);
    expect(r.compositorDrops).toBe(0);
    expect(markedWindow([meta], "a", "b")).toBeNull();
  });

  it("a trace with no frames reports zero frames instead of a pass by absence", () => {
    expect(attributeDrops([meta]).frames).toBe(0);
  });
});

describe("judgeGate (R6.4)", () => {
  const w = (mode: GateWindow["mode"], o: Partial<GateWindow> = {}): GateWindow => ({
    mode,
    appDrops: 0,
    longTasks: 0,
    otherDrops: 0,
    maxOtherGapVsyncs: 0,
    ...o,
  });
  const abba = (board: Partial<GateWindow>[] = [], control: Partial<GateWindow>[] = []) => {
    const b = (i: number) => w("board", board[i]);
    const c = (i: number) => w("control", control[i]);
    return [c(0), b(0), b(1), c(1), c(2), b(2), b(3), c(3)];
  };

  it("passes when board windows have no app drops and no more host drops than the control", () => {
    expect(judgeGate(abba()).pass).toBe(true);
    expect(judgeGate(abba([{ otherDrops: 2 }], [{ otherDrops: 1 }, { otherDrops: 1 }])).pass).toBe(true);
  });

  it("fails on one app drop in one board window; the other windows being clean does not help", () => {
    const r = judgeGate(abba([{}, { appDrops: 1 }]));
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toContain("window 3");
  });

  it("fails on a long task, and on board host drops beyond control + 1", () => {
    expect(judgeGate(abba([{ longTasks: 1 }])).pass).toBe(false);
    expect(judgeGate(abba([{ otherDrops: 2 }, { otherDrops: 1 }])).pass).toBe(false);
  });

  it("ignores drops in control windows for the app rule, but not a non-app gap over 2 vsyncs on the board", () => {
    expect(judgeGate(abba([], [{ appDrops: 3, longTasks: 2 }])).pass).toBe(true);
    expect(judgeGate(abba([{ maxOtherGapVsyncs: 3 }])).pass).toBe(false);
  });

  it("refuses to pass without enough windows of both kinds", () => {
    expect(judgeGate([w("board"), w("control")]).pass).toBe(false);
  });
});
