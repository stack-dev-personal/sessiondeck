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

/** Busy ratio per renderer main thread, tasks clipped to [t0, t0 + windowUs]. */
export function mainThreadBusy(events: TraceEvent[], windowUs: number) {
  const mains = new Set<string>();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name" && e.args?.["name"] === "CrRendererMain") {
      mains.add(`${e.pid}:${e.tid}`);
    }
  }
  const tasks = events.filter(
    (e) => e.name === "RunTask" && e.ph === "X" && mains.has(`${e.pid}:${e.tid}`),
  );
  const t0 = Math.min(...tasks.map((e) => e.ts));
  const t1 = t0 + windowUs;
  const perThread = new Map<string, { busyUs: number; tasks: number; longest: number }>();
  for (const e of tasks) {
    const a = Math.max(e.ts, t0);
    const b = Math.min(e.ts + (e.dur ?? 0), t1);
    if (b <= a) continue;
    const k = `${e.pid}:${e.tid}`;
    const cur = perThread.get(k) ?? { busyUs: 0, tasks: 0, longest: 0 };
    cur.busyUs += b - a;
    cur.tasks++;
    cur.longest = Math.max(cur.longest, b - a);
    perThread.set(k, cur);
  }
  // Our JS: the trace's script entry points on a main thread, longest single one.
  const SCRIPT = new Set(["FireAnimationFrame", "TimerFire", "EventDispatch", "FunctionCall"]);
  const maxScriptUs = events
    .filter((e) => e.ph === "X" && SCRIPT.has(e.name) && mains.has(`${e.pid}:${e.tid}`))
    .reduce((m, e) => Math.max(m, e.dur ?? 0), 0);
  const threads = [...perThread.entries()]
    .map(([thread, v]) => ({
      thread,
      busyPct: r2((v.busyUs / windowUs) * 100),
      tasks: v.tasks,
      longestTaskMs: r2(v.longest / 1000),
    }))
    .sort((a, b) => b.busyPct - a.busyPct);
  return {
    busyPct: threads[0]?.busyPct ?? 0,
    maxScriptMs: r2(maxScriptUs / 1000),
    threads,
    mainThreads: mains.size,
  };
}
