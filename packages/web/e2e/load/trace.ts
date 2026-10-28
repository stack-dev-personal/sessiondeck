/** Chrome trace analysis for R3.6 (plain functions, no Playwright import). */

export interface TraceEvent {
  ph: string;
  /** Thread CPU time of a complete event, µs (absent in synthetic traces). */
  tdur?: number;
  name: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: Record<string, unknown>;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Chromium builds name the top-level task either way; DevTools accepts both. */
export const TASK_NAMES: ReadonlySet<string> = new Set([
  "RunTask",
  "ThreadControllerImpl::RunTask",
]);
/** Script entry points on the main thread: our JS. */
const SCRIPT = new Set(["FireAnimationFrame", "TimerFire", "EventDispatch", "FunctionCall"]);

const GC = /GC|V8\.GC/;
const clippedDur = (e: TraceEvent, t0: number, t1: number): number =>
  Math.min(e.ts + (e.dur ?? 0), t1) - Math.max(e.ts, t0);

const key = (e: { pid: number; tid: number }): string => `${e.pid}:${e.tid}`;

function mainThreadKeys(events: TraceEvent[]): Set<string> {
  const mains = new Set<string>();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name" && e.args?.["name"] === "CrRendererMain") {
      mains.add(key(e));
    }
  }
  return mains;
}

/** Total length of the union of [start, end) intervals (nested or overlapping ones count once). */
export function unionLength(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curA = NaN;
  let curB = NaN;
  for (const [a, b] of sorted) {
    if (Number.isNaN(curA)) {
      curA = a;
      curB = b;
    } else if (a <= curB) {
      curB = Math.max(curB, b);
    } else {
      total += curB - curA;
      curA = a;
      curB = b;
    }
  }
  if (!Number.isNaN(curA)) total += curB - curA;
  return total;
}

/**
 * Busy ratio per renderer main thread: union of top-level task intervals (RunTask or
 * ThreadControllerImpl::RunTask), clipped to [t0, t0 + windowUs] where t0 is the first task.
 * `taskCount` is the number of tasks counted on the busiest thread; callers assert a floor so a
 * trace with no recognised tasks cannot pass as "0 % busy".
 */
export function mainThreadBusy(events: TraceEvent[], windowUs: number) {
  const mains = mainThreadKeys(events);
  const tasks = events.filter((e) => e.ph === "X" && TASK_NAMES.has(e.name) && mains.has(key(e)));
  const t0 = tasks.reduce((m, e) => Math.min(m, e.ts), Infinity);
  const t1 = t0 + windowUs;
  const byThread = new Map<string, { iv: [number, number][]; longest: number }>();
  for (const e of tasks) {
    const a = Math.max(e.ts, t0);
    const b = Math.min(e.ts + (e.dur ?? 0), t1);
    if (b <= a) continue;
    const k = key(e);
    const cur = byThread.get(k) ?? { iv: [], longest: 0 };
    cur.iv.push([a, b]);
    cur.longest = Math.max(cur.longest, b - a);
    byThread.set(k, cur);
  }
  const busiest = [...byThread.entries()].sort(
    (x, y) => unionLength(y[1].iv) - unionLength(x[1].iv),
  )[0]?.[0];
  // Script events on the busiest main thread only, clipped to [t0, t1].
  const scripts = events.filter(
    (e) =>
      e.ph === "X" &&
      SCRIPT.has(e.name) &&
      key(e) === busiest &&
      e.ts + (e.dur ?? 0) > t0 &&
      e.ts < t1,
  );
  const longest = scripts.reduce<TraceEvent | null>(
    (m, e) => (m === null || clippedDur(e, t0, t1) > clippedDur(m, t0, t1) ? e : m),
    null,
  );
  const maxScriptUs = longest ? clippedDur(longest, t0, t1) : 0;
  // GC inside the longest script task: it counts against rule (a) but is not our code.
  const gcUs = longest
    ? events
        .filter(
          (e) =>
            e.ph === "X" &&
            key(e) === busiest &&
            GC.test(e.name) &&
            e.ts >= longest.ts &&
            e.ts + (e.dur ?? 0) <= longest.ts + (longest.dur ?? 0),
        )
        .reduce((sum, e) => sum + (e.dur ?? 0), 0)
    : 0;
  const threads = [...byThread.entries()]
    .map(([thread, v]) => ({
      thread,
      busyPct: r2((unionLength(v.iv) / windowUs) * 100),
      tasks: v.iv.length,
      longestTaskMs: r2(v.longest / 1000),
    }))
    .sort((a, b) => b.busyPct - a.busyPct);
  return {
    busyPct: threads[0]?.busyPct ?? 0,
    taskCount: threads[0]?.tasks ?? 0,
    maxScriptMs: r2(maxScriptUs / 1000),
    maxScriptGcMs: r2(gcUs / 1000),
    threads,
    mainThreads: mains.size,
  };
}

/**
 * Evidence for each main-thread task longer than `minMs`: the names and longest durations of the
 * events nested inside it (what the task spent its time on).
 */
export function longTaskDetails(events: TraceEvent[], minMs = 50) {
  const mains = mainThreadKeys(events);
  const onMain = events.filter((e) => e.ph === "X" && mains.has(key(e)));
  const all = onMain.filter((e) => TASK_NAMES.has(e.name) && (e.dur ?? 0) >= minMs * 1000);
  // Outermost only: a task nested in another long task is the same work.
  const long = all.filter(
    (t) =>
      !all.some(
        (o) =>
          o !== t &&
          key(o) === key(t) &&
          o.ts <= t.ts &&
          o.ts + (o.dur ?? 0) >= t.ts + (t.dur ?? 0) &&
          (o.ts < t.ts || (o.dur ?? 0) > (t.dur ?? 0)),
      ),
  );
  return long.map((t) => {
    const end = t.ts + (t.dur ?? 0);
    const best = new Map<string, number>();
    for (const e of onMain) {
      if (e === t || TASK_NAMES.has(e.name) || key(e) !== key(t)) continue;
      if (e.ts < t.ts || e.ts + (e.dur ?? 0) > end) continue;
      best.set(e.name, Math.max(best.get(e.name) ?? 0, e.dur ?? 0));
    }
    const children = [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, us]) => ({ name, maxMs: r2(us / 1000) }));
    return { durMs: r2((t.dur ?? 0) / 1000), children };
  });
}

/**
 * Script time on the busiest renderer main thread, in ms per second of the window: the union of
 * script entry events (nested ones count once) clipped to [t0, t0 + windowUs], t0 = first task.
 */
export function scriptMsPerSecond(events: TraceEvent[], windowUs: number): number {
  const mains = mainThreadKeys(events);
  const tasks = events.filter((e) => e.ph === "X" && TASK_NAMES.has(e.name) && mains.has(key(e)));
  const t0 = tasks.reduce((m, e) => Math.min(m, e.ts), Infinity);
  const t1 = t0 + windowUs;
  const perThread = new Map<string, [number, number][]>();
  for (const e of events) {
    if (e.ph !== "X" || !SCRIPT.has(e.name) || !mains.has(key(e))) continue;
    const a = Math.max(e.ts, t0);
    const b = Math.min(e.ts + (e.dur ?? 0), t1);
    if (b <= a) continue;
    const list = perThread.get(key(e)) ?? [];
    list.push([a, b]);
    perThread.set(key(e), list);
  }
  const busiest = Math.max(0, ...[...perThread.values()].map((iv) => unionLength(iv)));
  return r2(busiest / 1000 / (windowUs / 1e6));
}

/**
 * Compositor frame outcomes from `PipelineReporter` async events (categories `benchmark` and
 * `rail`). Each reported frame carries `args.frame_reporter.state` (older builds: `chrome_frame_reporter`); `STATE_DROPPED` is a
 * frame the compositor or renderer did not deliver. Works for a stalled raster or GPU thread with
 * an idle main thread, which the in-page rAF gaps cannot see.
 */
export function pipelineFrames(events: TraceEvent[], edgeMs = 100) {
  const states: Record<string, number> = {};
  const dropReasons: Record<string, number> = {};
  const reported: { ts: number; state: string; args: Record<string, unknown> }[] = [];
  for (const e of events) {
    if (e.name !== "PipelineReporter") continue;
    const rep = (e.args?.["frame_reporter"] ?? e.args?.["chrome_frame_reporter"]) as
      { state?: string; reason?: string } | undefined;
    if (!rep || typeof rep.state !== "string") continue;
    reported.push({ ts: e.ts, state: rep.state, args: rep as Record<string, unknown> });
    states[rep.state] = (states[rep.state] ?? 0) + 1;
    if (rep.state === "STATE_DROPPED") {
      const why = rep.reason ?? "unknown";
      dropReasons[why] = (dropReasons[why] ?? 0) + 1;
    }
  }
  const first = reported.reduce((m, f) => Math.min(m, f.ts), Infinity);
  const last = reported.reduce((m, f) => Math.max(m, f.ts), -Infinity);
  // Where each dropped frame sits in the trace, to tell tracing start/stop edges from mid-window drops.
  const droppedAt = reported
    .filter((f) => f.state === "STATE_DROPPED")
    .map((f) => ({
      fromStartMs: r2((f.ts - first) / 1000),
      fromEndMs: r2((last - f.ts) / 1000),
      hasMainAnimation: f.args["has_main_animation"] === true,
      frameType: String(f.args["frame_type"] ?? ""),
    }));
  // The first and last frames of a trace are tracing start-up and shut-down, not the page: a
  // dropped frame within `edgeMs` of either end is counted apart (`droppedAtEdge`).
  const mid = droppedAt.filter((d) => d.fromStartMs >= edgeMs && d.fromEndMs >= edgeMs);
  return {
    total: reported.length,
    dropped: mid.length,
    droppedAtEdge: droppedAt.length - mid.length,
    states,
    dropReasons,
    droppedAt,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* R6.4 drop attribution                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Main-thread work that is the page's own: script, layout and style, paint and commit, GC. */
type WorkKind = "script" | "layout" | "paint" | "gc";
const WORK: Record<string, WorkKind> = {
  FireAnimationFrame: "script",
  TimerFire: "script",
  EventDispatch: "script",
  FunctionCall: "script",
  Layout: "layout",
  UpdateLayoutTree: "layout",
  RecalculateStyles: "layout",
  "LocalFrameView::RunStyleAndLayoutLifecyclePhases": "layout",
  "LocalFrameView::RunPrePaintLifecyclePhase": "paint",
  "LocalFrameView::RunPaintLifecyclePhase": "paint",
  PrePaint: "paint",
  Paint: "paint",
  Layerize: "paint",
  Commit: "paint",
  CullRectUpdate: "paint",
};
const workKind = (name: string): WorkKind | undefined =>
  WORK[name] ?? (GC.test(name) ? "gc" : undefined);

/** App work inside a frame gap or dropped frame at or above this many ms makes the drop the app's. */
export const APP_WORK_MS = 8;

/** Bounds of the measured window: the `console.timeStamp` marks the test puts in the trace. */
export function markedWindow(
  events: TraceEvent[],
  start = "r64-start",
  end = "r64-end",
): [number, number] | null {
  const at = (msg: string): number | undefined =>
    events.find(
      (e) =>
        e.name === "TimeStamp" &&
        ((e.args?.["data"] as { message?: string } | undefined)?.message ?? "") === msg,
    )?.ts;
  const a = at(start);
  const b = at(end);
  return a !== undefined && b !== undefined && b > a ? [a, b] : null;
}

export interface Drop {
  kind: "raf-gap" | "compositor";
  /** Start of the gap or frame, ms after the window start. */
  atMs: number;
  /** Length of the gap (raf-gap) or of the dropped frame (compositor), ms. */
  lengthMs: number;
  /** Renderer main-thread work inside it by the clock on the wall, ms (union of events, nesting counts once). */
  wallMs: number;
  /** The same work as CPU time the thread actually ran (tdur), ms: time spent descheduled is not in it. */
  cpuMs: number;
  /** The figure the verdict uses: cpuMs (basis "cpu") or wallMs (basis "wall"). */
  workMs: number;
  byKind: Record<WorkKind, number>;
  /** workMs >= the threshold: the page's own work filled the gap. */
  app: boolean;
}

/**
 * Splits every dropped frame in the window into the app's and the host's.
 *
 * Frames: gaps between consecutive `FireAnimationFrame` starts on the renderer main thread (the
 * in-page rAF loop runs in each one). A gap longer than `factor` x the median gap is a drop.
 * Compositor: every `PipelineReporter` frame whose state is STATE_DROPPED and that starts inside
 * the window. For each drop the union of script, layout/style, paint/commit and GC events on the
 * main thread inside the gap (or the frame's interval) is summed; `appWorkMs` or more means the
 * main thread was busy with the app's own work (the app's drop), less means it was idle or waiting
 * (the host's: a descheduled thread, a slow raster or GPU stall).
 * `window` is the measured window in trace ts (see markedWindow); without it the whole trace.
 */
export function attributeDrops(
  events: TraceEvent[],
  opts: {
    window?: [number, number] | null;
    factor?: number;
    appWorkMs?: number;
    /** What "work" means: CPU time the thread ran (default) or wall time. */
    basis?: "cpu" | "wall";
  } = {},
) {
  const basis = opts.basis ?? "cpu";
  const factor = opts.factor ?? 1.5;
  const limitUs = (opts.appWorkMs ?? APP_WORK_MS) * 1000;
  const mains = mainThreadKeys(events);
  const main = events.filter((e) => e.ph === "X" && mains.has(key(e)));
  const t0 = opts.window?.[0] ?? -Infinity;
  const t1 = opts.window?.[1] ?? Infinity;
  const origin = opts.window?.[0] ?? main.reduce((m, e) => Math.min(m, e.ts), Infinity);

  const work = main
    .filter((e) => workKind(e.name) !== undefined && (e.dur ?? 0) > 0)
    .map((e) => ({
      a: e.ts,
      b: e.ts + (e.dur ?? 0),
      // Share of the event's wall time the thread was running (1 when the trace has no tdur).
      ratio: e.tdur === undefined ? 1 : Math.min(1, e.tdur / (e.dur ?? 1)),
      kind: workKind(e.name)!,
    }))
    .sort((x, y) => x.a - y.a || y.b - x.b);
  const inside = (a: number, b: number) => {
    const by: Record<WorkKind, [number, number][]> = { script: [], layout: [], paint: [], gc: [] };
    const all: [number, number][] = [];
    // CPU time: sweep the events in start order; an event nested in an earlier one adds nothing.
    let cpuUs = 0;
    let covered = -Infinity;
    for (const w of work) {
      if (w.b <= a || w.a >= b) continue;
      const iv: [number, number] = [Math.max(w.a, a), Math.min(w.b, b)];
      by[w.kind].push(iv);
      all.push(iv);
      const from = Math.max(iv[0], covered);
      if (iv[1] > from) cpuUs += (iv[1] - from) * w.ratio;
      covered = Math.max(covered, iv[1]);
    }
    const ms = (iv: [number, number][]) => r2(unionLength(iv) / 1000);
    const wallMs = ms(all);
    const cpuMs = r2(cpuUs / 1000);
    return {
      wallMs,
      cpuMs,
      workMs: basis === "cpu" ? cpuMs : wallMs,
      byKind: { script: ms(by.script), layout: ms(by.layout), paint: ms(by.paint), gc: ms(by.gc) },
    };
  };

  // rAF gaps. The first frame's predecessor is outside the window, so gaps start inside it.
  const starts = main
    .filter((e) => e.name === "FireAnimationFrame" && e.ts >= t0 && e.ts <= t1)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianUs = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const drops: Drop[] = [];
  gaps.forEach((g, i) => {
    if (g <= factor * medianUs) return;
    const a = starts[i]!;
    drops.push({
      kind: "raf-gap",
      atMs: r2((a - origin) / 1000),
      lengthMs: r2(g / 1000),
      ...inside(a, a + g),
      app: false,
    });
  });

  // Compositor frames in STATE_DROPPED: pair each async begin with the next end of the same id.
  const open = new Map<string, TraceEvent>();
  let compositorFrames = 0;
  for (const e of events) {
    if (e.name !== "PipelineReporter") continue;
    const id = `${e.pid}:${String((e as { id2?: { local?: string } }).id2?.local ?? "")}`;
    if (e.ph === "b") {
      open.set(id, e);
      continue;
    }
    if (e.ph !== "e") continue;
    const begin = open.get(id);
    open.delete(id);
    if (!begin || begin.ts < t0 || begin.ts > t1) continue;
    const rep = (begin.args?.["frame_reporter"] ?? begin.args?.["chrome_frame_reporter"]) as
      | { state?: string }
      | undefined;
    if (typeof rep?.state !== "string") continue;
    compositorFrames++;
    if (rep.state !== "STATE_DROPPED") continue;
    drops.push({
      kind: "compositor",
      atMs: r2((begin.ts - origin) / 1000),
      lengthMs: r2((e.ts - begin.ts) / 1000),
      ...inside(begin.ts, e.ts),
      app: false,
    });
  }
  for (const d of drops) d.app = d.workMs * 1000 >= limitUs;
  drops.sort((a, b) => a.atMs - b.atMs);

  const rafGaps = drops.filter((d) => d.kind === "raf-gap");
  const compositor = drops.filter((d) => d.kind === "compositor");
  const other = drops.filter((d) => !d.app);
  return {
    frames: starts.length,
    medianGapMs: r2(medianUs / 1000),
    maxGapMs: r2((sorted[sorted.length - 1] ?? 0) / 1000),
    compositorFrames,
    rafGaps: rafGaps.length,
    compositorDrops: compositor.length,
    appDrops: drops.filter((d) => d.app).length,
    otherDrops: other.length,
    /** Longest rAF gap that is not the app's, in vsyncs (gap / median). */
    maxOtherGapVsyncs: r2(
      Math.max(0, ...other.filter((d) => d.kind === "raf-gap").map((d) => d.lengthMs)) /
        (medianUs / 1000 || 1),
    ),
    drops,
  };
}
