// R2.9 bench: builds a database of 30 days of "typical volume", then times `hub replay` and a
// compaction pass in fresh child processes (so peak RSS is the command's own).
//
// Typical volume (docs/planning/phases/phase-2-hub.md: a busy session emits 5-20 envelopes/s in
// tool bursts; two machines, several sessions each), made explicit:
//   - 2 hosts, 300 sessions (150 per host), 3,400 envelopes per session = 1,020,000 events,
//     spread over 30 days (about 34,000/day, 0.4/s average; bursts of 5-20/s with idle gaps)
//   - mix per session: 80% hook (the golden session's non-lifecycle hooks cycled in order:
//     PreToolUse/PostToolUse dominate, plus SubagentStart/Stop, Stop, Notification, ...), 12%
//     statusline (the 20 captured statusLine fixtures cycled), 3% liveness, 5% transcript
//     (5 lines of 400-800 bytes each); every session has a SessionStart and a SessionEnd
//   - payloads are the captured fixtures' (golden session: 213,286 bytes over 295 events, 723 B
//     per hook on average)
// The floor in the work unit is 1,000,000 events across at least 2 hosts and 300 sessions.
//
//   node scripts/bench-replay.mjs [--dir /tmp/sd-1-S4-bench] [--events 1020000] [--sessions 300]
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Store } from "../src/db/store.ts";
import { Ingestor, type Logger } from "../src/ingest/ingestor.ts";
import { replay } from "../src/replay.ts";
import { DAY_MS, compactEvents } from "../src/retention.ts";
import { synthSessions, type Rec } from "./synth-spool.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : dflt;
};
const mode = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "all";
const dir = opt("dir", "/tmp/sd-1-S4-bench");
const dbPath = path.join(dir, "hub.sqlite");
const TOTAL_EVENTS = Number(opt("events", "1020000"));
const SESSIONS = Number(opt("sessions", "300"));

const quiet: Logger = { info: () => undefined, warn: () => undefined };
const mb = (b: number): string => (b / 1024 / 1024).toFixed(1);

function generate(): void {
  const store = Store.open(dbPath);
  store.db.pragma("synchronous = OFF");
  store.migrate();
  const ing = new Ingestor(store, quiet, Date.now, { maxOpenSessionsPerHost: 100000 });
  const t0 = Date.now() - 30 * DAY_MS;
  let generated = 0;
  let accepted = 0;
  let payloadBytes = 0;
  const g0 = performance.now();
  let s = 0;
  for (const { host, envelopes: out } of synthSessions({
    sessions: SESSIONS,
    totalEvents: TOTAL_EVENTS,
    t0,
    spanMs: 29 * DAY_MS,
  })) {
    for (const e of out) payloadBytes += JSON.stringify(e.payload).length;
    for (let i = 0; i < out.length; i += 500) {
      const r = ing.ingest(host, out.slice(i, i + 500));
      accepted += r.accepted;
    }
    generated += out.length;
    s++;
    if (s % 50 === 0) {
      console.log(
        `generated ${s}/${SESSIONS} sessions, ${generated} events, ${Math.round((performance.now() - g0) / 1000)} s`,
      );
    }
  }
  store.db.pragma("wal_checkpoint(TRUNCATE)");
  const n = store.countEvents();
  console.log(
    `generate: events=${n} (generated ${generated}, accepted ${accepted}) avg_payload=${Math.round(payloadBytes / generated)} B elapsed=${Math.round((performance.now() - g0) / 1000)} s`,
  );
  if (n !== generated) throw new Error("generated events were deduplicated; the volume is wrong");
  store.close();
}

function childReplay(): void {
  const store = Store.open(dbPath);
  store.migrate();
  const warnings: object[] = [];
  const log: Logger = { info: () => undefined, warn: (o) => void warnings.push(o) };
  const r = replay(store, log, { maxOpenSessionsPerHost: 100000 });
  const rss = process.resourceUsage().maxRSS * 1024;
  console.log(
    JSON.stringify({
      ...r,
      events_per_s: Math.round(r.events / (r.elapsedMs / 1000)),
      peak_rss_bytes: rss,
      warnings: warnings.length,
    }),
  );
  store.close();
}

async function childCompact(): Promise<void> {
  const store = Store.open(dbPath);
  store.migrate();
  // Diagnostic: --autocheckpoint <pages> (0 = off) separates WAL checkpoint stalls (shared with ingest) from fold cost.
  const ck = opt("autocheckpoint", "");
  if (ck !== "") store.db.pragma(`wal_autocheckpoint = ${Number(ck)}`);
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  // Independent lag probe: a 1 ms timer measures how late it fires while compaction yields.
  let maxLag = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 1);
    last = now;
  }, 1);
  const cutoffMs = Date.now() - Number(opt("cutoff-days", "15")) * DAY_MS;
  const before = store.countEvents();
  const r = await compactEvents(store, quietLog(), {
    cutoffMs,
    maxTs: Date.now() + DAY_MS,
    maxOpenSessionsPerHost: 100000,
  });
  clearInterval(probe);
  h.disable();
  console.log(
    JSON.stringify({
      ...r,
      events_before: before,
      events_after: store.countEvents(),
      loop_lag_max_ms: Math.round(maxLag * 100) / 100,
      loop_delay_max_ms: Math.round((h.max / 1e6) * 100) / 100,
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
  store.close();
}
const quietLog = (): Logger => quiet;

function child(m: string): Rec {
  const r = spawnSync(
    process.execPath,
    [process.argv[1] as string, m, "--dir", dir, ...args.slice(args[0]?.startsWith("--") ? 0 : 1)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (r.status !== 0) throw new Error(`${m} child failed: ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) as string) as Rec;
}

if (mode === "gen") generate();
else if (mode === "replay") childReplay();
else if (mode === "compact") await childCompact();
else {
  generate();
  const size = (f: string): number => {
    try {
      return statSync(f).size;
    } catch {
      return 0;
    }
  };
  const dbBytes = size(dbPath) + size(`${dbPath}-wal`);
  const store = Store.open(dbPath);
  const counts = {
    events: store.countEvents(),
    sessions: (store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
    hosts: store.countHosts(),
    samples: (
      store.db.prepare("SELECT COUNT(*) AS n FROM statusline_samples").get() as { n: number }
    ).n,
  };
  store.close();
  const r = child("replay") as {
    events: number;
    sessions: number;
    elapsedMs: number;
    events_per_s: number;
    peak_rss_bytes: number;
    exceptions: number;
  };
  const c = child("compact") as Record<string, number>;
  console.log("--- bench-replay ---");
  console.log(`events:           ${counts.events}`);
  console.log(`sessions:         ${counts.sessions}`);
  console.log(`hosts:            ${counts.hosts}`);
  console.log(`samples:          ${counts.samples}`);
  console.log(`db size:          ${mb(dbBytes)} MB`);
  console.log(
    `replay elapsed:   ${r.elapsedMs} ms (${(r.elapsedMs / 1000).toFixed(1)} s)  target < 60000 ms: ${r.elapsedMs < 60_000 ? "PASS" : "FAIL"}`,
  );
  console.log(`replay events/s:  ${r.events_per_s}`);
  console.log(`replay peak RSS:  ${mb(r.peak_rss_bytes)} MB`);
  console.log(`replay reducer exceptions: ${r.exceptions}`);
  console.log(
    `compact (cutoff ${opt("cutoff-days", "15")} d): ${c["events"]} events in ${c["batches"]} batches, ${c["elapsedMs"]} ms, p50 ${c["p50BatchMs"]} ms, p99 ${c["p99BatchMs"]} ms, max batch ${c["maxBatchMs"]} ms`,
  );
  console.log(
    `compact event-loop: max timer lag ${c["loop_lag_max_ms"]} ms, histogram max ${c["loop_delay_max_ms"]} ms, peak RSS ${mb(c["peak_rss_bytes"] as number)} MB`,
  );
  if (r.elapsedMs >= 60_000) process.exitCode = 1;
}
