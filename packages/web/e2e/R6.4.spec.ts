import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { shot } from "./helpers";
import { buildPreset } from "../src/layout/presets";
import { assignSession } from "../src/layout/ops";
import { panesOf, serialize } from "../src/layout/spec";
import { HOST, LIVE, configureHub, waitConnected } from "./live-helpers";
import { createLoad } from "./load/generate";
import { judgeGate, type GateWindow } from "./load/gate";
import {
  APP_WORK_MS,
  attributeDrops,
  longTaskDetails,
  mainThreadBusy,
  markedWindow,
  pipelineFrames,
  scriptMsPerSecond,
  type TraceEvent,
} from "./load/trace";
import { SCREENS_DIR } from "./screens-dir";

/**
 * R6.4: six live content panes at 20 deltas/s, no dropped frames.
 *
 * MEASUREMENT DEFINITION
 *  Setup: mock build (no hub). Six live sessions are pushed into the board store and every activity
 *  log is pre-seeded to the cap (ACTIVITY_CAP rows), so the measured steady state is "append and trim
 *  on every update". `a` (auto-fit) lays them out as grid6 with one session per pane: six virtualized
 *  lists, pinned to the bottom. The load generator (e2e/load/generate.ts, same event mix as R3.6)
 *  builds the envelopes in Node, sized from the number of windows (no schedule is ever replayed);
 *  a timer in the page delivers them to the store's enqueue() on a fixed 50 ms schedule, exactly
 *  where the WebSocket handler delivers in a live build. The store coalesces per animation frame.
 *  BOARD: 20 deltas/s in total across the six sessions (1 per 50 ms tick, round robin) = the
 *  requirement. STRICT: 20 deltas/s for EACH session = 120/s (informational only, see below).
 *  CONTROL: the same page and the same 20/s tick, but each tick only repaints a 24 px dot; no store,
 *  list or layout work. It shows what this host drops when the page does nothing of its own.
 *
 *  RUN: one page, one traced primer (discarded: the first trace of a page's life makes Chromium
 *  start its tracing agents and drops frames), then EIGHT 12 s windows in ABBA order, each under a
 *  Chromium trace (devtools.timeline, toplevel, benchmark, rail):
 *      control, board, board, control, control, board, board, control
 *  so host drift hits both sides equally. EVERY window counts. There is no early stop, no best-of
 *  rule and no window is skipped or re-measured. A CPU probe brackets each window and is reported
 *  (`hostSlowdown`) but never removes a window.
 *
 *  DROPPED FRAME, measured in the trace (e2e/load/trace.ts attributeDrops), inside the window that
 *  console.timeStamp marks r64-start and r64-end bound:
 *   - an rAF GAP: two consecutive FireAnimationFrame starts on the renderer main thread more than
 *     1.5 x the window's median gap apart (the in-page rAF loop runs in every one);
 *   - a COMPOSITOR drop: a PipelineReporter frame in STATE_DROPPED.
 *  ATTRIBUTION: for each drop, the renderer main-thread work inside the gap (or the dropped frame's
 *  interval) is summed as the union of script, layout/style, paint/commit and GC events. APP_WORK_MS
 *  (8 ms) or more: the page's own work filled it, the drop is the APP's. Less: the main thread was
 *  idle or waiting, the drop is the HOST's (descheduled thread, slow raster or GPU).
 *  LONG TASK: a main-thread task over 50 ms (PerformanceObserver and the trace's top-level RunTask).
 *
 *  GATE (judgeGate in e2e/load/gate.ts, unit-tested): PASS only if
 *   (a) every board window has 0 app drops and 0 long tasks;
 *   (b) the host's drops (not the app's) summed over the board windows are at most the control
 *       windows' sum + 1;
 *   (c) no board window has a non-app rAF gap longer than 2 vsyncs;
 *   (d) there are 4 board and 4 control windows.
 *  The median gap must also be below 20 ms in every window, so a page that renders at 30 Hz cannot
 *  pass as "no dropped frames".
 *
 *  `strict-120` (120/s in all) is measured the same way in three windows; its structural checks run
 *  (rate, six lists, bounded DOM, pinned) but its drop counts never fail the test: on this shared
 *  WSL2 host it is noisy even when the page is healthy.
 *  Reported per window: frames, rAF-gap drops (in-page loop and trace), app drops, max interval,
 *  long tasks, compositor drops, script ms per second, main-thread busy %, store flushes per second,
 *  every drop with its length and the work inside it. Also asserted: the delivered rate is within
 *  5 % of the target in every window, six lists with bounded DOM rows, every list pinned, every
 *  log at the cap.
 * Evidence (MODE is `mock` or `live`): R6.4-trace-MODE.json (brief), R6.4-trace-summary-MODE.json
 * (everything), every board window's raw trace gzipped (R6.4-trace-CASE-wN.json.gz), R6.4-six-panes*.png.
 * A live variant (real hub, same ABBA run; control windows pause the generator; logs are not
 * forced to the cap, the hub makes fewer rows per delta) runs when
 * SD_E2E_HUB_URL is set (scripts/e2e-live.sh).
 */
const WARMUP_MS = 3_000;
const WINDOW_MS = 12_000;
const PRIMER_MS = 4_000;
const SETTLE_MS = 400;
const ABBA = [
  "control",
  "board",
  "board",
  "control",
  "control",
  "board",
  "board",
  "control",
] as const;
const MODE = LIVE.hubUrl === "" ? "mock" : "live";
const TICK_MS = 50;
/** Wall time a window takes beyond its 12 s: probes, start/stop of tracing, the evaluates. */
const WINDOW_OVERHEAD_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DriveMode = "board" | "control";

interface Perf {
  on: boolean;
  transitionEnds: number;
  frames: number[];
  appRaf: number;
  longtasks: number[];
  wsSession: number;
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const r2 = (n: number): number => Math.round(n * 100) / 100;

type Row = Record<string, unknown>;
interface CaseResult {
  gate: boolean;
  rule: string;
  pass: boolean | null;
  failures: string[];
  windows: Row[];
  [k: string]: unknown;
}
const summaries: Record<string, CaseResult> = {};

/**
 * Writes the evidence files after every case (a failing case restarts the worker, so an
 * end-of-run hook would lose the earlier cases). Cases already in the file from this run are kept.
 */
function writeEvidence(): void {
  const summaryFile = join(SCREENS_DIR, `R6.4-trace-summary-${MODE}.json`);
  const briefFile = join(SCREENS_DIR, `R6.4-trace-${MODE}.json`);
  const read = (f: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const all = { ...read(summaryFile), ...summaries };
  writeFileSync(summaryFile, JSON.stringify({ ...all, requirement: "R6.4", mode: MODE }, null, 2));
  // The compact form the reviewer reads: the verdict and one row per window (no drop lists).
  const brief = Object.fromEntries(
    Object.entries(all)
      .filter(([, v]) => typeof v === "object" && v !== null && "windows" in v)
      .map(([k, v]) => {
        const m = v as CaseResult;
        return [
          k,
          {
            gate: m.gate,
            pass: m.pass,
            failures: m.failures,
            rule: m.rule,
            windows: m.windows.map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => key !== "drops")),
            ),
          },
        ];
      }),
  );
  writeFileSync(briefFile, JSON.stringify({ requirement: "R6.4", mode: MODE, ...brief }, null, 2));
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const rec: Perf = {
      on: false,
      transitionEnds: 0,
      frames: [],
      appRaf: 0,
      longtasks: [],
      wsSession: 0,
    };
    // Reduced motion must not start transitions: a 0.01 ms transition per changed property put
    // thousands of transitionend events and a second style/paint pass per update on the page.
    document.addEventListener("transitionend", () => rec.on && rec.transitionEnds++, true);
    w["__perf"] = rec;
    // Live: count the `session` messages this page's WebSockets receive (deltas delivered).
    const NativeWS = window.WebSocket;
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args: ConstructorParameters<typeof WebSocket>) {
        const ws = new target(...args);
        ws.addEventListener("message", (ev: MessageEvent) => {
          if (rec.on && typeof ev.data === "string" && /^\{\s*"type"\s*:\s*"session"/.test(ev.data))
            rec.wsSession++;
        });
        return ws;
      },
    });
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
      /* unsupported: the trace still decides */
    }
  });
}

/** Reads panes, lists and pinning from the DOM, and how full each session's log is from the store. */
const paneState = (page: Page) =>
  page.evaluate(() => {
    const board = (
      window as unknown as {
        __sd?: { board: { getState: () => { activity?: Record<string, { rows: unknown[] }> } } };
      }
    ).__sd?.board.getState();
    const panes = [...document.querySelectorAll('[data-testid="pane"][data-pane-type="session"]')];
    return panes.map((p) => ({
      session: p.getAttribute("data-session-id"),
      lists: p.querySelectorAll('[data-testid="activity-list"]').length,
      pinned: p.querySelector('[data-testid="activity-list"]')?.getAttribute("data-pinned"),
      total: Number(p.querySelector('[role="log"]')?.getAttribute("data-total") ?? 0),
      domRows: p.querySelectorAll("[data-row]").length,
      logRows: board?.activity?.[p.getAttribute("data-session-id") ?? ""]?.rows.length ?? -1,
    }));
  });

/** Pushes the generator's envelopes into the store until every log of `ids` is at the cap. */
async function seedLogs(page: Page, envs: Record<string, unknown>[], ids: string[], cap: number) {
  await page.evaluate((batch) => {
    const board = (
      window as unknown as {
        __sd: { board: { getState: () => { enqueue: (e: unknown) => void } } };
      }
    ).__sd.board;
    for (const e of batch) board.getState().enqueue({ ...e, ts: Date.now() });
  }, envs);
  await expect
    .poll(
      () =>
        page.evaluate(
          ([want, cap]) => {
            const act = (
              window as unknown as {
                __sd: { board: { getState: () => { activity: Record<string, { rows: unknown[] }> } } };
              }
            ).__sd.board.getState().activity;
            return want!.every((id) => (act[id as string]?.rows.length ?? 0) >= (cap as number));
          },
          [ids, cap] as const,
        ),
      { message: "every log pre-seeded to the cap", timeout: 20_000 },
    )
    .toBe(true);
}

function analyse(buf: Buffer, wallMs: number, data: Perf & { hw: number }) {
  const trace = JSON.parse(buf.toString("utf8")) as { traceEvents: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(trace) ? trace : trace.traceEvents;
  const busy = mainThreadBusy(events, wallMs * 1000);
  const intervals: number[] = [];
  for (let i = 1; i < data.frames.length; i++)
    intervals.push(data.frames[i]! - data.frames[i - 1]!);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = pct(sorted, 50);
  const longEvidence = longTaskDetails(events);
  const secs = wallMs / 1000;
  const window = markedWindow(events);
  return {
    windowMs: wallMs,
    frames: data.frames.length,
    droppedFrameIntervals: intervals.filter((d) => d > 1.5 * median).length,
    frameIntervalMs: {
      p50: r2(median),
      p95: r2(pct(sorted, 95)),
      p99: r2(pct(sorted, 99)),
      max: r2(sorted[sorted.length - 1] ?? 0),
    },
    markedWindow: window !== null,
    attribution: window === null ? null : attributeDrops(events, { window }),
    pipeline: pipelineFrames(events),
    transitionEnds: data.transitionEnds,
    longTasksObserver: data.longtasks.length,
    longTasksTrace: longEvidence.length,
    longTaskMs: data.longtasks.map(r2),
    longTaskEvidence: longEvidence,
    scriptMsPerSecond: scriptMsPerSecond(events, wallMs * 1000),
    maxScriptTaskMs: busy.maxScriptMs,
    mainThreadBusyPct: busy.busyPct,
    countedTasks: busy.taskCount,
    mainThreads: busy.threads.length,
    storeFlushesPerSec: r2(data.appRaf / secs),
    hardwareConcurrency: data.hw,
    traceEvents: events.length,
  };
}
type Analysis = ReturnType<typeof analyse>;

async function measure(page: Page, browser: Browser) {
  await browser.startTracing(page, {
    categories: [
      "-*",
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "toplevel",
      "v8",
      "v8.gc",
      // Compositor frame outcomes (PipelineReporter, state DROPPED): catches a raster or GPU
      // stall with an idle main thread.
      "benchmark",
      "rail",
    ],
  });
  // The window is bounded inside the page and marked in the trace (console.timeStamp), so tracing
  // start-up and shut-down time counts toward neither the window nor the delivered rate.
  const t0 = await page.evaluate(() => {
    const w = window as unknown as { __perf: Perf; __drive?: { delivered: number } };
    const r = w.__perf;
    r.frames = [];
    r.transitionEnds = 0;
    r.appRaf = 0;
    r.longtasks = [];
    r.wsSession = 0;
    r.on = true;
    console.timeStamp("r64-start");
    return { at: performance.now(), delivered: w.__drive?.delivered ?? 0 };
  });
  await sleep(WINDOW_MS);
  const { data, t1 } = await page.evaluate(() => {
    const w = window as unknown as { __perf: Perf; __drive?: { delivered: number } };
    const r = w.__perf;
    r.on = false;
    console.timeStamp("r64-end");
    return {
      data: { ...r, hw: navigator.hardwareConcurrency },
      t1: { at: performance.now(), delivered: w.__drive?.delivered ?? 0 },
    };
  });
  const buf = await browser.stopTracing();
  return { buf, wallMs: t1.at - t0.at, data, delivered: t1.delivered - t0.delivered };
}

/** CPU probe: median ms of five fixed spins on the page's main thread. Slower than usual = a busy host. */
const calibrate = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      let x = 0;
      for (let i = 0; i < 2_000_000; i++) x += Math.sqrt(i);
      if (x < 0) console.log(x);
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[2]!;
  });

interface Win {
  mode: DriveMode;
  m: Analysis;
  buf: Buffer;
  run: Awaited<ReturnType<typeof measure>>;
  gate: GateWindow;
  row: Row;
}

/**
 * Measures one window per entry of `modes`, in order, on the running page. `setMode` switches the
 * load (store deltas or the paint control). Every window is kept.
 */
async function runWindows(
  page: Page,
  browser: Browser,
  modes: readonly DriveMode[],
  setMode: (m: DriveMode) => Promise<void>,
  deliveredOf: (run: Awaited<ReturnType<typeof measure>>, mode: DriveMode) => number,
): Promise<{ wins: Win[]; fastestProbeMs: number }> {
  // Primer: the first trace of a page's life makes Chromium start its tracing agents and re-enable
  // compositor frame reporting while the page runs, which drops frames in that window (seen as 25 to
  // 100 STATE_DROPPED in window 1 and 1 to 4 afterwards, with the same app). One traced, discarded
  // period first, so every measured window is a steady-state window.
  await browser.startTracing(page, { categories: ["-*", "devtools.timeline", "benchmark", "rail"] });
  await sleep(PRIMER_MS);
  await browser.stopTracing();
  const wins: Win[] = [];
  const probes: number[] = [];
  const probeOf: [number, number][] = [];
  for (const [k, mode] of modes.entries()) {
    await setMode(mode);
    await sleep(SETTLE_MS);
    const before = await calibrate(page);
    const run = await measure(page, browser);
    const after = await calibrate(page);
    probes.push(before, after);
    probeOf.push([before, after]);
    const m = analyse(run.buf, run.wallMs, run.data);
    const a = m.attribution;
    const longTasks = Math.max(m.longTasksObserver, m.longTasksTrace);
    const gate: GateWindow = {
      mode,
      appDrops: a?.appDrops ?? Number.POSITIVE_INFINITY,
      longTasks,
      otherDrops: a?.otherDrops ?? Number.POSITIVE_INFINITY,
      maxOtherGapVsyncs: a?.maxOtherGapVsyncs ?? Number.POSITIVE_INFINITY,
    };
    wins.push({
      mode,
      m,
      buf: run.buf,
      run,
      gate,
      row: {
        window: k + 1,
        mode,
        probeBeforeMs: r2(before),
        probeAfterMs: r2(after),
        frames: m.frames,
        rafGapDropsInPage: m.droppedFrameIntervals,
        rafGapDrops: a?.rafGaps ?? null,
        compositorDrops: a?.compositorDrops ?? null,
        appDrops: a?.appDrops ?? null,
        hostDrops: a?.otherDrops ?? null,
        maxIntervalMs: m.frameIntervalMs.max,
        maxGapTraceMs: a?.maxGapMs ?? null,
        medianGapTraceMs: a?.medianGapMs ?? null,
        p99IntervalMs: m.frameIntervalMs.p99,
        maxHostGapVsyncs: a?.maxOtherGapVsyncs ?? null,
        longTasks,
        longTasksObserver: m.longTasksObserver,
        longTasksTrace: m.longTasksTrace,
        compositorFramesReported: a?.compositorFrames ?? null,
        scriptMsPerSecond: m.scriptMsPerSecond,
        mainThreadBusyPct: m.mainThreadBusyPct,
        deliveredPerSec: r2(deliveredOf(run, mode) / (run.wallMs / 1000)),
        drops: a?.drops ?? [],
      },
    });
  }
  const fastest = Math.min(...probes);
  wins.forEach((w, i) => {
    w.row["hostSlowdown"] = r2(Math.max(...probeOf[i]!) / fastest);
  });
  return { wins, fastestProbeMs: r2(fastest) };
}

/** Structural checks on every window of every case; drop counts are judged by judgeGate. */
function expectSound(
  name: string,
  perSec: number,
  wins: readonly Win[],
  panes: Awaited<ReturnType<typeof paneState>>,
  minRows = 20,
  cap: number | null = 500,
) {
  for (const { m, row } of wins) {
    const tag = `${name} window ${row["window"]} (${row["mode"]})`;
    expect(row["deliveredPerSec"], `${tag}: delivered deltas per second`).toBeGreaterThanOrEqual(
      perSec * 0.95,
    );
    expect(m.mainThreads, `${tag}: renderer main thread found in trace`).toBeGreaterThan(0);
    expect(m.markedWindow, `${tag}: r64 marks in trace`).toBe(true);
    expect(m.attribution?.frames, `${tag}: frames in trace window`).toBeGreaterThanOrEqual(
      (WINDOW_MS / 1000) * 50,
    );
    expect(m.countedTasks, `${tag}: tasks counted in trace`).toBeGreaterThanOrEqual(500);
    expect(m.pipeline.total, `${tag}: PipelineReporter frames in trace`).toBeGreaterThan(100);
    expect(m.frames, `${tag}: frames in window`).toBeGreaterThanOrEqual((WINDOW_MS / 1000) * 50);
    expect(m.frameIntervalMs.p50, `${tag}: median frame interval (60 fps)`).toBeLessThan(20);
    expect(m.transitionEnds, `${tag}: transitionend events`).toBe(0);
  }
  expect(panes, `${name}: six session panes`).toHaveLength(6);
  for (const p of panes) {
    expect(p.lists, `${p.session}: one list`).toBe(1);
    expect(p.total, `${p.session}: rows buffered`).toBeGreaterThan(minRows);
    expect(p.domRows, `${p.session}: DOM rows bounded`).toBeLessThan(60);
    expect(p.pinned, `${p.session}: pinned to bottom`).toBe("true");
    if (cap !== null)
      expect(p.logRows, `${p.session}: log at the cap (trim on every update)`).toBe(cap);
  }
}

/** Table of every window for the test log. */
const table = (wins: readonly Win[]): string =>
  wins
    .map((w) => {
      const r = w.row;
      return `w${r["window"]} ${String(r["mode"]).padEnd(7)} frames=${r["frames"]} rafGaps=${r["rafGapDrops"]} app=${r["appDrops"]} host=${r["hostDrops"]} comp=${r["compositorDrops"]} maxInt=${r["maxIntervalMs"]} long=${r["longTasks"]} slow=${r["hostSlowdown"]}`;
    })
    .join("\n");

function record(
  name: string,
  gate: boolean,
  wins: readonly Win[],
  verdict: { pass: boolean; failures: string[] } | null,
  extra: Row,
): CaseResult {
  const res: CaseResult = {
    gate,
    rule: gate
      ? `ABBA, 8 windows, every one counts: board windows 0 app drops (>= ${APP_WORK_MS} ms of own main-thread work in the gap) and 0 long tasks; host drops board <= control + 1; no host gap over 2 vsyncs`
      : "informational: measured and reported, drop counts do not fail the test",
    pass: verdict?.pass ?? null,
    failures: verdict?.failures ?? [],
    windows: wins.map((w) => w.row),
    ...extra,
  };
  summaries[name] = res;
  console.log(`R6.4 ${name} verdict=${verdict ? (verdict.pass ? "PASS" : "FAIL") : "n/a"}\n${table(wins)}`);
  writeEvidence();
  return res;
}

function saveBoardTraces(name: string, wins: readonly Win[]): void {
  for (const w of wins)
    if (w.mode === "board")
      writeFileSync(
        join(SCREENS_DIR, `R6.4-trace-${name}-w${w.row["window"]}.json.gz`),
        gzipSync(w.buf),
      );
}

test.describe("mock build, in-page delivery", () => {
  test.skip(LIVE.hubUrl !== "", "mock build only (the live variant is below)");

  const MOCK_CASES = [
    {
      name: "board-20",
      perSec: 20,
      gate: true,
      modes: ABBA,
      perTick: (t: number) => [t % 6],
    },
    {
      name: "strict-120",
      perSec: 120,
      gate: false,
      modes: ["board", "board", "board"] as const,
      perTick: () => [0, 1, 2, 3, 4, 5],
    },
  ] as const;

  for (const c of MOCK_CASES) {
    test(`R6.4 six panes, ${c.name}: ${c.perSec} deltas/s, 0 dropped frames${c.gate ? "" : " (informational)"}`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(600_000);
      await installProbes(page);
      await page.goto("/layout?replay=fast&preset=pair");
      await expect(page.locator("html")).toHaveAttribute("data-replay", "done", {
        timeout: 30_000,
      });

      const load = createLoad({ hosts: ["h1", "h2"], sessions: 6 });
      const setup = [...load.setupBatch("h1"), ...load.setupBatch("h2")];
      const ids = load.sessions.map((s) => s.id);
      // Seed: enough deltas that every log is past the cap before the first measurement (measured:
      // about one row per delta, so 700 per session), so the steady state trims on every update.
      const seed = Array.from({ length: 700 * 6 }, (_, i) => load.nextFor(i % 6));
      // The schedule is sized from the run: warm-up + primer + windows, never replayed.
      const totalMs =
        WARMUP_MS + PRIMER_MS + c.modes.length * (WINDOW_MS + WINDOW_OVERHEAD_MS) + 30_000;
      const ticks: Record<string, unknown>[][] = Array.from(
        { length: Math.ceil(totalMs / TICK_MS) },
        (_, t) => c.perTick(t).map((i) => load.nextFor(i)),
      );

      await page.evaluate((envs) => {
        const board = (
          window as unknown as {
            __sd: { board: { getState: () => Record<string, (...a: unknown[]) => void> } };
          }
        ).__sd.board;
        board.getState()["replaceAll"]!([]);
        for (const e of envs) board.getState()["enqueue"]!(e);
      }, setup);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Object.keys(
                (
                  window as unknown as {
                    __sd: { board: { getState: () => { sessions: object } } };
                  }
                ).__sd.board.getState().sessions,
              ).length,
          ),
        )
        .toBe(6);
      await seedLogs(page, seed, ids, 500);
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("a");
      await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", "grid6");
      const held = await page
        .locator('[data-pane-type="session"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));
      expect([...held].sort()).toEqual([...ids].sort());

      // The in-page delivery timer: fixed schedule (no drift), restamped with the current time.
      // `mode` picks what a tick does: "board" enqueues the deltas, "control" only repaints a dot.
      await page.evaluate(
        ([schedule, tickMs]) => {
          const w = window as unknown as {
            __sd: { board: { getState: () => { enqueue: (e: unknown) => void } } };
            __drive: { delivered: number; stop: boolean; mode: string; exhausted: boolean };
          };
          const { enqueue } = w.__sd.board.getState();
          const st = { delivered: 0, stop: false, mode: "board", exhausted: false };
          const dot = document.createElement("div");
          dot.style.cssText =
            "position:fixed;right:0;bottom:0;width:24px;height:24px;pointer-events:none;z-index:1";
          document.body.appendChild(dot);
          w.__drive = st;
          const t0 = performance.now();
          let i = 0;
          const step = () => {
            if (st.stop) return;
            const batch = schedule[i];
            if (batch === undefined) {
              st.exhausted = true; // a replayed schedule would make state jump backward: refuse
              return;
            }
            for (const e of batch) {
              if (st.mode === "control") dot.style.background = st.delivered % 2 ? "#888" : "#444";
              else enqueue({ ...(e as object), ts: Date.now() });
              st.delivered++;
            }
            i++;
            setTimeout(step, Math.max(0, t0 + i * tickMs - performance.now()));
          };
          step();
        },
        [ticks, TICK_MS] as const,
      );

      await sleep(WARMUP_MS);
      const { wins, fastestProbeMs } = await runWindows(
        page,
        browser,
        c.modes,
        (mode) =>
          page.evaluate((m) => {
            (window as unknown as { __drive: { mode: string } }).__drive.mode = m;
          }, mode),
        (r) => r.delivered,
      );
      await page.screenshot({
        path: shot(`R6.4-six-panes${c.name === "strict-120" ? "" : `-${c.name}`}.png`),
      });
      if (c.name === "strict-120") await page.screenshot({ path: shot("R6.4.png") });
      const panes = await paneState(page);
      const exhausted = await page.evaluate(
        () => (window as unknown as { __drive: { exhausted: boolean } }).__drive.exhausted,
      );
      await page.evaluate(() => {
        (window as unknown as { __drive: { stop: boolean } }).__drive.stop = true;
      });

      const verdict = c.gate ? judgeGate(wins.map((w) => w.gate)) : null;
      record(c.name, c.gate, wins, verdict, {
        definition: {
          totalDeltasPerSec: c.perSec,
          tickMs: TICK_MS,
          warmupMs: WARMUP_MS,
          windowMs: WINDOW_MS,
          appWorkMs: APP_WORK_MS,
          scheduleTicks: ticks.length,
        },
        fastestProbeMs,
        panes,
      });
      saveBoardTraces(c.name, c.gate ? wins : []);
      expect(exhausted, `${c.name}: the delivery schedule ran out (state would replay)`).toBe(false);
      expectSound(c.name, c.perSec, wins, panes);
      if (verdict) expect(verdict.failures, `${c.name}: gate\n${table(wins)}`).toEqual([]);
    });
  }
});

test.describe("real hub (scripts/e2e-live.sh)", () => {
  test.skip(
    LIVE.hubUrl === "",
    "live variant: set SD_E2E_HUB_URL (scripts/e2e-live.sh, SD_E2E_ARGS=R6.4)",
  );

  // Same ABBA run through the hub: the generator POSTs /ingest, the hub broadcasts `session`
  // messages, the page's WebSocket delivers them. 6 sessions over 2 hosts, 3 per host per tick:
  // 2 x 3 / 300 ms = 20/s. Control windows stop the generator and repaint a dot at 20/s.
  const LIVE_CASES = [
    { name: "live-board-20", perSec: 20, tickMs: 300, gate: true, modes: ABBA },
  ] as const;

  for (const c of LIVE_CASES) {
    test(`R6.4 ${c.name}: six panes at ${c.perSec} deltas/s through the hub, 0 dropped frames`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(600_000);
      await installProbes(page);
      await configureHub(page);
      // Distinct hosts per case: the hub drops (host, seq) pairs it has seen, and each generator
      // numbers its envelopes from 1.
      const hosts: [string, string] = [`${HOST}-${c.name}-p1`, `${HOST}-${c.name}-p2`];
      // A seed per case: the same seed would reuse the session ids the previous case ended.
      const load = createLoad({
        hosts,
        sessions: 6,
        tickMs: c.tickMs,
        perHostPerTick: 3,
        seed: 640 + c.perSec,
      });
      const ids = load.sessions.map((x) => x.id);
      // The layout this viewer would have after `a`: grid6, one of our sessions in each pane.
      let spec = buildPreset("grid6");
      for (const [i, p] of panesOf(spec)
        .filter((q) => q.type === "session")
        .entries())
        spec = assignSession(spec, p.id, ids[i]!);
      await page.addInitScript((raw) => {
        try {
          window.localStorage.setItem("sd.layout", raw);
        } catch {
          /* ignore */
        }
      }, serialize(spec));
      try {
        await load.setup();
        await page.goto("/layout");
        await waitConnected(page);
        await expect
          .poll(async () => (await paneState(page)).filter((p) => p.total > 0).length, {
            timeout: 20_000,
          })
          .toBe(6);
        load.run();
        // In-page control: a dot repainted at 20/s, switched on while the generator is stopped.
        await page.evaluate(() => {
          const w = window as unknown as { __drive: { delivered: number; control: boolean } };
          const dot = document.createElement("div");
          dot.style.cssText =
            "position:fixed;right:0;bottom:0;width:24px;height:24px;pointer-events:none;z-index:1";
          document.body.appendChild(dot);
          const st = { delivered: 0, control: false };
          w.__drive = st;
          const t0 = performance.now();
          let i = 0;
          const step = () => {
            if (st.control) {
              dot.style.background = st.delivered % 2 ? "#888" : "#444";
              st.delivered++;
            }
            i++;
            setTimeout(step, Math.max(0, t0 + i * 50 - performance.now()));
          };
          step();
        });
        await sleep(WARMUP_MS);
        let running = true; // the generator was started above
        const { wins, fastestProbeMs } = await runWindows(
          page,
          browser,
          c.modes,
          async (mode) => {
            if (mode === "control" && running) {
              await load.stop();
              running = false;
            } else if (mode === "board" && !running) {
              load.run();
              running = true;
            }
            await page.evaluate((m) => {
              (window as unknown as { __drive: { control: boolean } }).__drive.control =
                m === "control";
            }, mode);
          },
          // Deltas delivered = `session` WebSocket messages the page received in the window
          // (board), or the dot repaints (control).
          (r, mode) => (mode === "board" ? r.data.wsSession : r.delivered),
        );
        await page.screenshot({ path: shot(`R6.4-six-panes-${c.name}.png`) });
        const panes = await paneState(page);
        const stats = await load.stop();
        const verdict = judgeGate(wins.map((w) => w.gate));
        record(c.name, c.gate, wins, verdict, { fastestProbeMs, failedPosts: stats.failedPosts, panes });
        saveBoardTraces(c.name, wins);
        expect(stats.failedPosts, "ingest posts failed").toBe(0);
        // Hub snapshots only produce a row when something visible changed, so fewer rows than mock.
        expectSound(c.name, c.perSec, wins, panes, 8, null);
        expect(verdict.failures, `${c.name}: gate\n${table(wins)}`).toEqual([]);
      } finally {
        await load.stop();
        await load.end();
      }
    });
  }
});
