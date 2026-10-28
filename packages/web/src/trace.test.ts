// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  longTaskDetails,
  mainThreadBusy,
  pipelineFrames,
  type TraceEvent,
} from "../e2e/load/trace";

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
