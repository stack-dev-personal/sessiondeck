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
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Envelope } from "@sessiondeck/contract";
import { Store } from "../src/db/store.ts";
import { Ingestor, type Logger } from "../src/ingest/ingestor.ts";
import { replay } from "../src/replay.ts";
import { DAY_MS, compactEvents } from "../src/retention.ts";

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
const HOSTS = ["laptop-win", "dev-box-linux"];
const FIX = path.resolve(import.meta.dirname, "../../contract/fixtures");

const quiet: Logger = { info: () => undefined, warn: () => undefined };
const mb = (b: number): string => (b / 1024 / 1024).toFixed(1);

// Deterministic PRNG (mulberry32) so runs are comparable.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(n: number): string {
  let s = "";
  let v = n;
  for (let i = 0; i < 25; i++) {
    s = B32[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return `0${s}`;
}

type Rec = Record<string, unknown>;
const golden = readFileSync(path.join(FIX, "sessions/golden-session.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Rec);
const start = golden.find((p) => p["hook_event_name"] === "SessionStart") as Rec;
const end = golden.find((p) => p["hook_event_name"] === "SessionEnd") as Rec;
const middle = golden.filter(
  (p) => !["SessionStart", "SessionEnd"].includes(String(p["hook_event_name"])),
);
const statuses = readdirSync(path.join(FIX, "statusLine"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(FIX, "statusLine", f), "utf8")) as Rec);

function generate(): void {
  const store = Store.open(dbPath);
  store.db.pragma("synchronous = OFF");
  store.migrate();
  const ing = new Ingestor(store, quiet, Date.now, { maxOpenSessionsPerHost: 100000 });
  const rand = rng(42);
  const perSession = Math.round(TOTAL_EVENTS / SESSIONS);
  const spanMs = 29 * DAY_MS;
  const t0 = Date.now() - 30 * DAY_MS;
  const seqOf = new Map<string, number>();
  let id = 1;
  let generated = 0;
  let accepted = 0;
  let payloadBytes = 0;
  const g0 = performance.now();
  for (let s = 0; s < SESSIONS; s++) {
    const host = HOSTS[s % HOSTS.length] as string;
    const sid = `bench-${String(s).padStart(4, "0")}-${ulid(s + 1)
      .slice(-8)
      .toLowerCase()}`;
    let ts = t0 + Math.floor((s / SESSIONS) * spanMs);
    const out: Envelope[] = [];
    const push = (kind: Envelope["kind"], payload: Rec, hook?: string): void => {
      const seq = (seqOf.get(host) ?? 0) + 1;
      seqOf.set(host, seq);
      out.push({
        v: 1,
        id: ulid(id++),
        kind,
        host,
        os: host.includes("win") ? "windows" : "linux",
        session_id: sid,
        ...(hook !== undefined ? { hook_event_name: hook } : {}),
        ts,
        seq,
        payload,
      } as Envelope);
    };
    const step = (): void => {
      // Bursts of 5-20 envelopes/s, then an idle gap.
      ts += Math.floor(1000 / (5 + rand() * 15));
      if (rand() < 0.02) ts += 5000 + Math.floor(rand() * 55_000);
    };
    push("hook", { ...start, session_id: sid }, "SessionStart");
    let hookIdx = 0;
    let statusIdx = 0;
    while (out.length < perSession - 1) {
      step();
      const r = rand();
      if (r < 0.12) {
        push("statusline", {
          ...(statuses[statusIdx++ % statuses.length] as Rec),
          session_id: sid,
        });
      } else if (r < 0.15) {
        push("liveness", { pid: 10_000 + s, alive: true });
        ts += 6000; // keeps repeats of the identical liveness payload outside the 5 s signature window
      } else if (r < 0.2) {
        const lineNo = out.length * 5;
        const lines = Array.from({ length: 5 }, (_, k) =>
          JSON.stringify({ n: lineNo + k, text: "x".repeat(400 + Math.floor(rand() * 400)) }),
        );
        push("transcript", { start_line: lineNo, lines });
      } else {
        const p = middle[hookIdx++ % middle.length] as Rec;
        push("hook", { ...p, session_id: sid }, String(p["hook_event_name"]));
      }
    }
    step();
    push("hook", { ...end, session_id: sid }, "SessionEnd");
    for (const e of out) payloadBytes += JSON.stringify(e.payload).length;
    for (let i = 0; i < out.length; i += 500) {
      const r = ing.ingest(host, out.slice(i, i + 500));
      accepted += r.accepted;
    }
    generated += out.length;
    if ((s + 1) % 50 === 0) {
      console.log(
        `generated ${s + 1}/${SESSIONS} sessions, ${generated} events, ${Math.round((performance.now() - g0) / 1000)} s`,
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
