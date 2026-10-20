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
  const maxScriptUs = events
    .filter((e) => e.ph === "X" && SCRIPT.has(e.name) && mains.has(key(e)))
    .reduce((m, e) => Math.max(m, e.dur ?? 0), 0);
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
  const long = onMain.filter((e) => TASK_NAMES.has(e.name) && (e.dur ?? 0) >= minMs * 1000);
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
