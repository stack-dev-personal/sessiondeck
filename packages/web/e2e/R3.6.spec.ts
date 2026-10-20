import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { HOST, LIVE, configureHub, waitConnected } from "./live-helpers";
import { createLoad } from "./load/generate";
import { longTaskDetails, mainThreadBusy, type TraceEvent } from "./load/trace";
import { shot } from "./helpers";
import { SCREENS_DIR } from "./screens-dir";

/**
 * R3.6: 20 live sessions across 2 hosts at 20 deltas/s, no dropped frames, main thread < 50% busy.
 * Live spec (needs a hub; packages/web/scripts/e2e-live.sh). SD_E2E_SKIP_PERF=1 skips it.
 *
 * Two windows in one page with the same 20 populated cards, each 30 s after a 3 s settle, each
 * under a Chromium trace (devtools.timeline):
 *  1. idle baseline: the generator is off (no /ingest posts at all). The app's own 1 Hz elapsed
 *     tick keeps running, as it does in production.
 *  2. load: e2e/load/generate.ts posts 20 deltas/s (2 hosts x 2 envelopes per 200 ms tick,
 *     distinct sessions, so the hub broadcasts one `session` message per envelope).
 * The baseline tells dropped frames the app causes from ones the headless, software-rendered,
 * shared-VM environment causes.
 *
 * R3.6 pass definition (all four asserted on the load window):
 *  (a) longest script task < 16.7 ms (one frame at 60 Hz). Script task = the longest
 *      FireAnimationFrame, TimerFire, EventDispatch or FunctionCall event on the renderer main
 *      thread in the trace: our JS never costs a frame by itself.
 *  (b) dropped-frame intervals under load <= dropped-frame intervals in the idle window + 0.5% of
 *      the load window's frames. A dropped-frame interval is a gap between consecutive
 *      requestAnimationFrame callbacks of an in-page loop longer than 1.5x the median gap.
 *  (c) main-thread busy < 50%: the union of top-level tasks (RunTask or
 *      ThreadControllerImpl::RunTask) on the renderer main thread (CrRendererMain; the busiest
 *      one if several exist), clipped to the window, over the window length. At least 1000 tasks
 *      must be counted, in both windows, so an unrecognised trace cannot read as 0%.
 *  (d) frame-interval p99 < 33 ms (two vsyncs at 60 Hz).
 * Also asserted: delta rate >= 19 `session` WebSocket messages per second, no failed posts.
 * Reported, not asserted: PerformanceObserver long tasks, and for every top-level task over 50 ms
 * in the trace the names and longest durations of the events inside it (`longTaskEvidence`).
 * Store flushes per second: the store schedules exactly one requestAnimationFrame per flush
 * (src/store/board.ts), so app rAF calls (the probe loop uses the unwrapped rAF) count flushes.
 * The summary JSON (both windows) is printed and written to R3.6-trace.json next to the
 * screenshot; the raw load trace is saved gzipped when under 20 MB.
 */
test.skip(LIVE.hubUrl === "", "live spec: set SD_E2E_HUB_URL (see playwright.config.ts)");
test.skip(process.env["SD_E2E_SKIP_PERF"] === "1", "SD_E2E_SKIP_PERF=1");

const WARMUP_MS = 3_000;
const WINDOW_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Perf {
  on: boolean;
  frames: number[];
  sessionMsgs: number;
  appRaf: number;
  longtasks: number[];
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const r2 = (n: number): number => Math.round(n * 100) / 100;

test("R3.6 20 sessions, 2 hosts, 20 deltas/s: main thread < 50% busy, no dropped frames", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const rec: Perf = { on: false, frames: [], sessionMsgs: 0, appRaf: 0, longtasks: [] };
    w["__perf"] = rec;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (rec.on) rec.appRaf++;
      return nativeRaf(cb);
    };
    const loop = (t: number) => {
      if (rec.on) rec.frames.push(t);
      nativeRaf(loop);
    };
    nativeRaf(loop);
    try {
      new PerformanceObserver((list) => {
        if (!rec.on) return;
        for (const e of list.getEntries()) rec.longtasks.push(e.duration);
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask unsupported: the trace still decides */
    }
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (ev) => {
          if (rec.on && typeof ev.data === "string" && ev.data.startsWith('{"type":"session"')) {
            rec.sessionMsgs++;
          }
        });
      }
    };
  });
  await configureHub(page);
  await page.goto("/board");
  await waitConnected(page);

  const hosts: [string, string] = [`${HOST}-p1`, `${HOST}-p2`];
  const load = createLoad({ hosts });
  try {
    const mine = [...load.sessions.map((s) => s.id)];
    await load.setup();

    const ownCards = () =>
      page.evaluate((ids) => {
        const els = Array.from(document.querySelectorAll('[data-testid="session-card"]')).filter(
          (e) => ids.includes(e.getAttribute("data-session-id") ?? ""),
        );
        return {
          count: els.length,
          hosts: [
            ...new Set(els.map((e) => e.querySelector('[data-slot="host"]')?.textContent ?? "")),
          ],
        };
      }, mine);
    await expect.poll(async () => (await ownCards()).count, { timeout: 20_000 }).toBe(20);

    const measure = async (label: string, wallTarget: number) => {
      await browser.startTracing(page, {
        categories: [
          "-*",
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "toplevel",
        ],
      });
      await page.evaluate(() => {
        const r = (window as unknown as { __perf: Perf }).__perf;
        r.frames = [];
        r.sessionMsgs = 0;
        r.appRaf = 0;
        r.longtasks = [];
        r.on = true;
      });
      const wallStart = Date.now();
      await sleep(wallTarget);
      const wallMs = Date.now() - wallStart;
      const data = await page.evaluate(() => {
        const r = (window as unknown as { __perf: Perf }).__perf;
        r.on = false;
        return {
          frames: r.frames,
          sessionMsgs: r.sessionMsgs,
          appRaf: r.appRaf,
          longtasks: r.longtasks,
          hardwareConcurrency: navigator.hardwareConcurrency,
        };
      });
      const traceBuf = await browser.stopTracing();
      return { label, wallMs, data, traceBuf };
    };
    const analyse = (m: Awaited<ReturnType<typeof measure>>) => {
      const trace = JSON.parse(m.traceBuf.toString("utf8")) as
        { traceEvents: TraceEvent[] } | TraceEvent[];
      const events = Array.isArray(trace) ? trace : trace.traceEvents;
      const busy = mainThreadBusy(events, m.wallMs * 1000);
      const intervals: number[] = [];
      for (let i = 1; i < m.data.frames.length; i++) {
        intervals.push(m.data.frames[i]! - m.data.frames[i - 1]!);
      }
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = pct(sorted, 50);
      const secs = m.wallMs / 1000;
      return {
        windowMs: m.wallMs,
        mainThreadBusyPct: busy.busyPct,
        countedTasks: busy.taskCount,
        maxScriptTaskMs: busy.maxScriptMs,
        mainThreads: busy.threads,
        frames: m.data.frames.length,
        intervalsOver1_5xMedian: intervals.filter((d) => d > 1.5 * median).length,
        frameIntervalMs: {
          p50: r2(median),
          p95: r2(pct(sorted, 95)),
          p99: r2(pct(sorted, 99)),
          max: r2(sorted[sorted.length - 1] ?? 0),
        },
        longTasks: m.data.longtasks.length,
        longTaskMs: m.data.longtasks.map(r2),
        longTaskEvidence: longTaskDetails(events),
        sessionMsgsPerSec: r2(m.data.sessionMsgs / secs),
        storeFlushesPerSec: r2(m.data.appRaf / secs),
        browserHardwareConcurrency: m.data.hardwareConcurrency,
        traceEvents: events.length,
      };
    };

    // Window 1: idle baseline, generator off.
    await sleep(WARMUP_MS);
    const idleRaw = await measure("idle", WINDOW_MS);
    const idle = analyse(idleRaw);

    // Window 2: load, immediately after.
    load.run();
    await sleep(WARMUP_MS);
    const loadRaw = await measure("load", WINDOW_MS);
    const loaded = analyse(loadRaw);

    // Mid-load evidence, generator still running.
    await page.screenshot({ path: shot("R3.6.png") });
    const cards = await ownCards();
    const stats = await load.stop();

    const allowedOver = idle.intervalsOver1_5xMedian + Math.floor(loaded.frames * 0.005);
    const summary = {
      requirement: "R3.6",
      sessions: cards.count,
      hosts: cards.hosts,
      rule: {
        a_maxScriptTaskMsBelow: 16.7,
        b_droppedIntervalsAtMost: allowedOver,
        c_busyPctBelow: 50,
        d_p99MsBelow: 33,
      },
      idle,
      load: loaded,
      generator: { ...stats, ratePerSec: r2(stats.ratePerSec) },
      cpuCount: cpus().length,
    };
    const json = JSON.stringify(summary, null, 2);
    console.log(`R3.6 summary ${json}`);
    writeFileSync(join(SCREENS_DIR, "R3.6-trace.json"), json);
    const gz = gzipSync(loadRaw.traceBuf);
    if (gz.length < 20 * 1024 * 1024)
      writeFileSync(join(SCREENS_DIR, "R3.6-trace.raw.json.gz"), gz);

    expect(stats.failedPosts, "ingest posts failed").toBe(0);
    expect(cards.count).toBe(20);
    expect([...cards.hosts].sort()).toEqual([...hosts].sort());
    expect(loaded.sessionMsgsPerSec, "session deltas per second").toBeGreaterThanOrEqual(19);
    for (const [name, w] of [
      ["idle", idle],
      ["load", loaded],
    ] as const) {
      expect(w.mainThreads.length, `${name}: renderer main thread found in trace`).toBeGreaterThan(
        0,
      );
      expect(w.countedTasks, `${name}: tasks counted in trace`).toBeGreaterThanOrEqual(1000);
    }
    expect(loaded.mainThreadBusyPct, "(c) main thread busy %").toBeLessThan(50);
    expect(loaded.maxScriptTaskMs, "(a) longest script task (ms)").toBeLessThan(16.7);
    expect(
      loaded.intervalsOver1_5xMedian,
      "(b) dropped-frame intervals vs idle + 0.5%",
    ).toBeLessThanOrEqual(allowedOver);
    expect(loaded.frameIntervalMs.p99, "(d) frame interval p99 (ms)").toBeLessThan(33);
  } finally {
    await load.stop();
    await load.end();
  }
});
