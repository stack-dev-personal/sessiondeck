/** Chrome trace analysis for R3.6 (plain functions, no Playwright import). */

export interface TraceEvent {
  ph: string;
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
