// Ingest load harness (R2.4). Open-loop: batches are sent on a fixed schedule whether or not the
// previous ones have returned, and latency is measured from the SCHEDULED send time to the end of
// the response, so a stalled hub shows up as latency instead of as a quietly lower request rate
// (coordinated omission).
//
// Source data is synthesized by scripts/synth-spool.ts (the generator bench-replay.ts uses): 2
// hosts, many sessions, a mix of golden-session hooks, captured statusLines, liveness and
// transcript envelopes. The contract defines no spool file format (the spool belongs to the probe,
// which is not in this package), so `--spool <dir>` is not supported.
//
//   node scripts/load-ingest.mjs [--rate 1000] [--duration 60] [--batch 100]
//        sustained mode: `rate` envelopes/s in batches of `batch` (rate/batch POSTs per second)
//   node scripts/load-ingest.mjs --speed 10 [--events 180000] [--span-min 30]
//        replay mode: a synthetic busy "day" of `events` envelopes (default 360000) starting over `span-min` (15) minutes
//        (sessions then run about 40 min, about 100 envelopes/s overall), sent at `speed` times real time by envelope ts
//   --with-retention   in-process only: pre-seed `--seed-events` (default 600000) events older than
//        the retention window, run a compaction pass concurrently with the load, and report ingest
//        latency during and outside the pass separately
//   --hot-session      sustained mode: send every envelope (both hosts) as ONE session_id (worst case for the
//        dedup index walk: about 10k index entries per lookup)
//   --verify-live      afterwards GET /sessions?live=1 and compare with the sessions created
//   --url http://host:8787 --token-file <path>   test a running hub (never prints the token); http: only,
//        and loopback unless --allow-insecure (the bearer token is sent in clear text)
//   --p95-limit 20     exit 1 when batch p95 (ms) exceeds this or any request failed
//
// Default target: a real Fastify server on loopback and a real SQLite file under --dir
// (default /tmp/sd-1-S4-load), built from the same code and pragmas as `serve`. The client shares
// the hub's event loop in this mode, which can only overstate latency.
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { openSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const num = (n, d) => {
  const v = Number(opt(n, String(d)));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${n} must be a positive number`);
  return v;
};

const BATCH = num("batch", 100);
const SPEED = flag("speed") ? num("speed", 10) : null;
const RATE = num("rate", 1000);
const DURATION = num("duration", 60);
const WARMUP = Number(opt("warmup", "5")); // seconds of load before the measured window (JIT, caches)
const P95_LIMIT = num("p95-limit", 20);
const WITH_RETENTION = flag("with-retention");
const HOT_SESSION = flag("hot-session");
const SEED_EVENTS = num("seed-events", 600000);
const URL_ARG = opt("url", null);
const DIR = opt("dir", "/tmp/sd-1-S4-load");
const DAY_MS = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPAWN = flag("spawn");
if ((URL_ARG || SPAWN) && WITH_RETENTION)
  throw new Error("--with-retention needs the in-process hub");

// ---------- code under test ----------
const out = path.join(root, "dist", "load-harness-hub.mjs");
await build({
  stdin: {
    contents: [
      'export { buildServer } from "./src/server.ts";',
      'export { loadConfig } from "./src/config.ts";',
      'export { Store } from "./src/db/store.ts";',
      'export { Ingestor } from "./src/ingest/ingestor.ts";',
      'export { IngestActivity } from "./src/ingest/activity.ts";',
      'export { runRetention } from "./src/retention.ts";',
      'export { startCheckpointer, CHECKPOINT_INTERVAL_MS } from "./src/checkpoint.ts";',
      'export { synthSessions } from "./scripts/synth-spool.ts";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "load-entry.ts",
  },
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["better-sqlite3", "fastify", "ws"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});
const {
  IngestActivity,
  buildServer,
  loadConfig,
  Store,
  Ingestor,
  runRetention,
  startCheckpointer,
  CHECKPOINT_INTERVAL_MS,
  synthSessions,
} = await import(pathToFileURL(out).href);

// ---------- synthesize the spool ----------
const runStart = Date.now();
const idStart = runStart * 1000; // fresh ULIDs and (host, seq) per run, so reruns do not deduplicate
const seqStart = Math.floor(runStart / 1000) * 1000;
const sidPrefix = `load${(runStart % 1_000_000).toString(36)}`;
const totalEvents =
  SPEED !== null ? num("events", 360000) : Math.ceil(RATE * (DURATION + WARMUP) * 1.1);
const spanMs = SPEED !== null ? num("span-min", 15) * 60_000 : 120_000;
const sessionCount = Math.max(2, Math.round(totalEvents / (SPEED !== null ? 3400 : 600)));

const perHost = new Map(); // host -> envelopes
const sessionEnds = new Map(); // session_id -> SessionEnd ts (source clock, rebased below)
let minTs = Infinity;
let maxTs = 0;
for (const s of synthSessions({
  sessions: sessionCount,
  totalEvents,
  t0: 0,
  spanMs,
  idStart,
  seqStart,
  sidPrefix,
  stress: args.includes("--stress"), // branchless, text-free sessions with subagent transcript lines
})) {
  const list = perHost.get(s.host) ?? [];
  for (const e of s.envelopes) {
    list.push(e);
    minTs = Math.min(minTs, e.ts);
    maxTs = Math.max(maxTs, e.ts);
  }
  sessionEnds.set(s.session_id, s.envelopes.at(-1).ts);
  perHost.set(s.host, list);
}
const sourceSpan = maxTs - minTs;
// Rebase the source clock so the last envelope is stamped at about the end of the run: nothing is
// in the future beyond the run length, nothing is older than the sessions' own span.
const runMs = SPEED !== null ? sourceSpan / SPEED : (DURATION + WARMUP) * 1000;
const shift = Math.round(runStart + runMs - maxTs);
for (const list of perHost.values()) {
  list.sort((a, b) => a.ts - b.ts);
  let seq = seqStart;
  for (const e of list) {
    e.ts += shift;
    e.seq = ++seq;
  }
}
for (const [k, v] of sessionEnds) sessionEnds.set(k, v + shift);
if (HOT_SESSION) {
  // R3: every envelope of both hosts goes to ONE session_id, so the (session_id, ts, signature) dup check
  // walks the whole 10 s window of that session (about 10k entries at 1k/s).
  sessionEnds.clear();
  for (const list of perHost.values()) {
    const sid = `hot-${sidPrefix}`;
    for (const e of list) e.session_id = sid;
    sessionEnds.set(sid, list.at(-1).ts);
  }
}

// Batches: { at (ms after start), host, envelopes }.
const batches = [];
const hosts = [...perHost.keys()];
if (SPEED !== null) {
  for (const host of hosts) {
    const list = perHost.get(host);
    for (let i = 0; i < list.length; i += BATCH) {
      const slice = list.slice(i, i + BATCH);
      batches.push({
        at: (slice.at(-1).ts - shift - minTs) / SPEED,
        host,
        envelopes: slice,
      });
    }
  }
  batches.sort((a, b) => a.at - b.at);
} else {
  const cursor = new Map(hosts.map((h) => [h, 0]));
  const interval = (BATCH / RATE) * 1000;
  for (let k = 0; ; k++) {
    const host = hosts[k % hosts.length];
    const i = cursor.get(host);
    const list = perHost.get(host);
    if (i + BATCH > list.length) break;
    cursor.set(host, i + BATCH);
    batches.push({ at: k * interval, host, envelopes: list.slice(i, i + BATCH) });
  }
}
const sentEnvelopes = batches.reduce((n, b) => n + b.envelopes.length, 0);

// ---------- target ----------
const activity = new IngestActivity();
let baseUrl = URL_ARG;
let token = "";
let stopHub = async () => {};
let dbFile = null;
let store = null;
let logWarn = 0;
let logLines = 0;
let tmpDir = null;
const info = {};
if (URL_ARG) {
  token = readFileSync(opt("token-file", ""), "utf8").trim();
} else if (SPAWN) {
  // The production entry (dist/main.mjs, checkpoint worker, lease, retention timer) as a child
  // process on a temp DB: the client's own CPU no longer shares the hub's event loop.
  const { spawn, spawnSync } = await import("node:child_process");
  const b = spawnSync(process.execPath, ["scripts/bundle.mjs", "src/main.ts", "dist/main.mjs"], {
    cwd: root,
  });
  if (b.status !== 0) throw new Error("bundle failed");
  mkdirSync(DIR, { recursive: true });
  tmpDir = mkdtempSync(path.join(DIR, "run-"));
  dbFile = path.join(tmpDir, "hub.sqlite");
  token = randomBytes(24).toString("hex");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(root, "dist", "main.mjs")], {
    env: {
      ...process.env,
      HUB_TOKEN: token,
      HUB_DB_PATH: dbFile,
      HUB_PORT: String(port),
      HUB_PRICING_FETCH: "0",
    },
    stdio: ["ignore", openSync(path.join(tmpDir, "hub.log"), "w"), "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  baseUrl = `http://127.0.0.1:${port}`;
  stopHub = async () => {
    const done = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await done;
  };
} else {
  mkdirSync(DIR, { recursive: true });
  tmpDir = mkdtempSync(path.join(DIR, "run-"));
  dbFile = path.join(tmpDir, "hub.sqlite");
  token = randomBytes(24).toString("hex");
  let seeded = null;
  if (WITH_RETENTION) {
    // A separate connection with synchronous = OFF, only to build the old window quickly.
    const seedStore = Store.open(dbFile);
    seedStore.db.pragma("synchronous = OFF");
    seedStore.migrate();
    const ing = new Ingestor(seedStore, { info() {}, warn() {} }, Date.now, {
      maxOpenSessionsPerHost: 100000,
    });
    const s0 = performance.now();
    let n = 0;
    for (const s of synthSessions({
      sessions: Math.max(2, Math.round(SEED_EVENTS / 3400)),
      totalEvents: SEED_EVENTS,
      t0: runStart - 62 * DAY_MS,
      spanMs: 30 * DAY_MS,
      sidPrefix: "seed",
    })) {
      for (let i = 0; i < s.envelopes.length; i += 500) {
        n += ing.ingest(s.host, s.envelopes.slice(i, i + 500)).accepted;
      }
    }
    seedStore.db.pragma("wal_checkpoint(TRUNCATE)");
    seedStore.close();
    seeded = { events: n, ms: Math.round(performance.now() - s0) };
    console.log(`pre-seeded ${n} events older than 31 days in ${seeded.ms} ms`);
  }
  store = Store.open(dbFile);
  store.migrate();
  const config = loadConfig({ HUB_TOKEN: token, HUB_PORT: "8787" });
  // As in serve(): WAL checkpoints run on a worker thread. --no-checkpointer measures the old behavior.
  const checkpointer = flag("no-checkpointer")
    ? { stop: async () => {} }
    : startCheckpointer(
        store,
        dbFile,
        { info() {}, warn: (o, m) => console.error(m, o) },
        Number(opt("ckpt-ms", String(CHECKPOINT_INTERVAL_MS))),
      );
  info.pragmas = {
    journal_mode: store.db.pragma("journal_mode", { simple: true }),
    synchronous: store.db.pragma("synchronous", { simple: true }),
    wal_autocheckpoint: store.db.pragma("wal_autocheckpoint", { simple: true }),
  };
  info.pragmas.checkpointer = flag("no-checkpointer")
    ? "off (automatic checkpoints)"
    : "worker thread";
  const app = buildServer({
    config,
    store,
    activity,
    // Real pino logging as in production (one line per batch plus request lines), counted not printed.
    logStream: {
      write(m) {
        logLines++;
        if (m.includes('"level":40') || m.includes('"level":50')) {
          logWarn++;
          if (logWarn <= 3) console.error(`hub log: ${m.slice(0, 400).trim()}`);
        }
      },
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  stopHub = async () => {
    await app.close();
    await checkpointer.stop();
    store.close();
  };
  info.config = config;
  info.seeded = seeded;
}
const target = new URL(baseUrl);
// The client speaks plain node:http: refuse anything else so a bearer token is never sent in clear
// to a host the operator believes is behind TLS (S2). Non-loopback http needs --allow-insecure.
if (target.protocol !== "http:") {
  throw new Error(`--url must be http: (got ${target.protocol}); TLS targets are not supported`);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && !flag("allow-insecure")) {
  throw new Error(
    `--url ${target.hostname} is not loopback: the token would cross the network in clear text; pass --allow-insecure to do it anyway`,
  );
}
const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent,
        host: target.hostname,
        port: target.port,
        method,
        path: p,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// ---------- run ----------
const health = await fetch(`${baseUrl}/health`);
if (health.status !== 200) throw new Error(`/health returned ${health.status}`);

let results = []; // { at, done, ms (from scheduled), svc (from actual send), status, accepted, expired, n }
let compactionP95 = null; // p95 of batches overlapping the pass (--with-retention)
let compaction = null; // { start, end, result } relative to load start
const t0 = performance.now();
let inflight = 0;
let maxDispatchLag = 0;
let firstError = null;
let next = 0;
let finished;
const allDone = new Promise((r) => (finished = r));
let retention = null;
if (WITH_RETENTION) {
  const cfg = info.config;
  // Starts when the measured window opens, so the whole pass lands inside it.
  retention = (async () => {
    await sleep(WARMUP * 1000);
    const startC = performance.now() - t0;
    const r = await runRetention(
      store,
      { info() {}, warn: (o, m) => console.error("retention:", m, o) },
      {
        eventRetentionDays: cfg.eventRetentionDays,
        sampleRetentionDays: cfg.sampleRetentionDays,
        maxOpenSessionsPerHost: cfg.maxOpenSessionsPerHost,
        maxClockSkewMs: cfg.maxClockSkewMs,
        compactBatchSize: Number(opt("compact-batch", String(cfg.compactBatchSize))),
        compactBatchBudgetMs: Number(opt("compact-batch-ms", String(cfg.compactBatchBudgetMs))),
        compactMaxEvents: cfg.compactMaxEvents,
        // As serve() wires it: compaction yields to the ingest requests under test.
        activity,
      },
    );
    compaction = { start: startC, end: performance.now() - t0, result: r };
  })();
}

function dispatch(b) {
  const sent = performance.now();
  const body = Buffer.from(JSON.stringify({ host: b.host, envelopes: b.envelopes }));
  inflight++;
  maxDispatchLag = Math.max(maxDispatchLag, sent - t0 - b.at);
  request("POST", "/ingest", body).then(
    (res) => {
      const done = performance.now();
      let accepted = 0;
      let expired = 0;
      if (res.status !== 200 && !firstError) {
        firstError = `${res.status} ${res.body.toString("utf8").slice(0, 200)}`;
      }
      if (res.status === 200) {
        const j = JSON.parse(res.body.toString("utf8"));
        accepted = j.accepted;
        expired = j.expired ?? 0;
      }
      results.push({
        at: b.at,
        done: done - t0,
        ms: done - t0 - b.at,
        svc: done - sent,
        status: res.status,
        accepted,
        expired,
        n: b.envelopes.length,
      });
      if (--inflight === 0 && next >= batches.length) finished();
    },
    (err) => {
      results.push({
        at: b.at,
        done: performance.now() - t0,
        ms: NaN,
        status: `err:${err.code ?? err.message}`,
        accepted: 0,
        expired: 0,
        n: b.envelopes.length,
      });
      if (--inflight === 0 && next >= batches.length) finished();
    },
  );
}

console.log(
  `sending ${batches.length} batches of ${BATCH} (${sentEnvelopes} envelopes, ${sessionEnds.size} sessions, ${hosts.length} hosts) over ${(batches.at(-1).at / 1000).toFixed(1)} s` +
    (SPEED !== null ? ` (replay at ${SPEED}x)` : ` (${RATE}/s)`),
);
await new Promise((resolve) => {
  const tick = () => {
    const now = performance.now() - t0;
    while (next < batches.length && batches[next].at <= now) dispatch(batches[next++]);
    if (next >= batches.length) return resolve();
    setTimeout(tick, Math.max(0, Math.min(2, batches[next].at - now)));
  };
  tick();
});
if (inflight > 0) await allDone;
if (retention !== null) await retention;

// ---------- report ----------
const pct = (arr, p) => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const f = (v) => (Number.isNaN(v) ? "n/a" : v.toFixed(2));
const everything = results;
const warm = results.filter((r) => r.at < WARMUP * 1000);
results = results.filter((r) => r.at >= WARMUP * 1000);
const okRes = results.filter((r) => r.status === 200);
const okAll = everything.filter((r) => r.status === 200);
const errors = {};
for (const r of everything) if (r.status !== 200) errors[r.status] = (errors[r.status] ?? 0) + 1;
const lat = okRes.map((r) => r.ms);
const accepted = okAll.reduce((n, r) => n + r.accepted, 0);
const expired = okAll.reduce((n, r) => n + r.expired, 0);
const sentOk = okAll.reduce((n, r) => n + r.n, 0);
const measuredN = okRes.reduce((n, r) => n + r.n, 0);
const windowS = (Math.max(...results.map((r) => r.done)) - WARMUP * 1000) / 1000;
console.log("--- load-ingest ---");
console.log(
  `target:            ${URL_ARG ? URL_ARG : SPAWN ? `child process hub (dist/main.mjs) on ${baseUrl}` : `in-process hub on ${baseUrl}`}`,
);
if (info.pragmas) console.log(`pragmas:           ${JSON.stringify(info.pragmas)}`);
console.log(
  `mode:              ${SPEED !== null ? `replay ${SPEED}x of ${(sourceSpan / 60000).toFixed(1)} min source` : `sustained ${RATE}/s x ${DURATION} s`}, batches of ${BATCH}`,
);
console.log(
  `envelopes:         sent ${sentEnvelopes} (${measuredN} in the measured window), accepted ${accepted}, duplicates ${sentOk - accepted - expired}, expired ${expired}`,
);
const warmLat = warm.filter((r) => r.status === 200).map((r) => r.ms);
console.log(
  `batches:           ${results.length} measured (ok ${okRes.length}) after a ${WARMUP} s warm-up of ${warm.length} batches (warm-up p95 ${f(pct(warmLat, 0.95))} ms, max ${f(Math.max(...warmLat))} ms)`,
);
console.log(`errors by status:  ${Object.keys(errors).length ? JSON.stringify(errors) : "none"}`);
if (flag("trace")) {
  const slow = [...okRes].sort((a, b) => b.ms - a.ms).slice(0, 15);
  console.log(
    `slowest: ${slow.map((r) => `t=${(r.at / 1000).toFixed(2)}s ${r.ms.toFixed(1)}ms`).join(", ")}`,
  );
}
if (firstError) console.log(`first error:       ${firstError}`);
console.log(
  `batch latency ms (scheduled send -> response): p50 ${f(pct(lat, 0.5))}  p95 ${f(pct(lat, 0.95))}  p99 ${f(pct(lat, 0.99))}  max ${f(Math.max(...lat))}`,
);
console.log(
  `service time ms (actual send -> response):     p50 ${f(
    pct(
      okRes.map((r) => r.svc),
      0.5,
    ),
  )}  p95 ${f(
    pct(
      okRes.map((r) => r.svc),
      0.95,
    ),
  )}  max ${f(Math.max(...okRes.map((r) => r.svc)))}`,
);
console.log(`max dispatch lag:  ${f(maxDispatchLag)} ms`);
console.log(
  `achieved rate:     ${Math.round(measuredN / windowS)} envelopes/s over the ${windowS.toFixed(1)} s measured window`,
);
if (WITH_RETENTION) {
  const c = compaction;
  const during = okRes.filter((r) => r.at <= c.end && r.done >= c.start).map((r) => r.ms);
  const outside = okRes.filter((r) => !(r.at <= c.end && r.done >= c.start)).map((r) => r.ms);
  const r = c.result.compact;
  console.log(
    `compaction:        ${r.events} events, ${r.batches} batches, ${r.elapsedMs} ms (load t=${(c.start / 1000).toFixed(1)}..${(c.end / 1000).toFixed(1)} s), batch p50 ${r.p50BatchMs} p99 ${r.p99BatchMs} max ${r.maxBatchMs} ms (${r.slowBatches} over 10 ms), samples deleted ${c.result.samples}`,
  );
  const left = store.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE ts < ?")
    .get(Date.now() - info.config.eventRetentionDays * DAY_MS).n;
  console.log(
    `compaction yield:  waited ${Math.round(r.yieldedMs)} ms for quiet, ${r.forcedBatches} forced batches, capped ${r.capped}, ${r.events} of ${info.seeded?.events ?? "?"} seeded events compacted (${(r.events / (r.elapsedMs / 1000)).toFixed(0)}/s), ${left} old events left`,
  );
  compactionP95 = pct(during, 0.95);
  console.log(
    `ingest during compaction (${during.length} batches): p50 ${f(pct(during, 0.5))}  p95 ${f(pct(during, 0.95))}  p99 ${f(pct(during, 0.99))}  max ${f(Math.max(...during))}`,
  );
  console.log(
    `ingest outside compaction (${outside.length} batches): p50 ${f(pct(outside, 0.5))}  p95 ${f(pct(outside, 0.95))}  p99 ${f(pct(outside, 0.99))}  max ${f(Math.max(...outside))}`,
  );
}
if (SPAWN) {
  // Hub-side view from its own pino lines: handler time (route entry to reply) and the ingest transaction.
  const resp = [];
  const ing = [];
  for (const line of readFileSync(path.join(tmpDir, "hub.log"), "utf8").split("\n")) {
    if (line.includes('"request completed"')) resp.push(JSON.parse(line).responseTime);
    else if (line.includes('"ingest batch"')) ing.push(JSON.parse(line).ms);
  }
  console.log(
    `hub-side ms:       request p50 ${f(pct(resp, 0.5))} p95 ${f(pct(resp, 0.95))}; ingest transaction p50 ${f(pct(ing, 0.5))} p95 ${f(pct(ing, 0.95))} (${ing.length} batches)`,
  );
}
if (dbFile && store === null) {
  const size = (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  console.log(
    `db size at end:    ${(size(dbFile) / 1048576).toFixed(1)} MB + wal ${(size(`${dbFile}-wal`) / 1048576).toFixed(1)} MB`,
  );
} else if (dbFile) {
  const size = (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(
    `db size at end:    ${mb(size(dbFile))} MB + wal ${mb(size(`${dbFile}-wal`))} MB; events ${store.countEvents()}`,
  );
  const w = store.db.pragma("wal_checkpoint(PASSIVE)")[0];
  console.log(`wal frames at end: ${w.log} (checkpointed ${w.checkpointed})`);
  console.log(`hub log:           ${logLines} lines, ${logWarn} warn/error`);
}

let live = null;
if (flag("verify-live")) {
  const res = await request("GET", "/sessions?live=1");
  const j = { sessions: JSON.parse(res.body.toString("utf8")) };
  const mine = j.sessions.filter((s) => sessionEnds.has(s.session_id)).length;
  const cutoff = Date.now() - 10 * 60_000;
  const expectedLive = [...sessionEnds.values()].filter((t) => t >= cutoff).length;
  live = {
    status: res.status,
    total: j.sessions.length,
    mine,
    created: sessionEnds.size,
    expectedLive,
  };
  console.log(
    `verify-live:       GET /sessions?live=1 -> ${res.status}, ${j.sessions.length} sessions, ${mine} of the ${sessionEnds.size} created (expected ${expectedLive}: ended under 10 min ago)`,
  );
}
await sleep(0);
agent.destroy();
await stopHub();
if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });

const p95 = pct(lat, 0.95);
let failed = false;
if (Object.keys(errors).length > 0) failed = true;
if (!(p95 <= P95_LIMIT)) failed = true;
if (compactionP95 !== null && !(compactionP95 <= P95_LIMIT)) failed = true; // R2.4 holds during compaction too
if (live && (live.status !== 200 || live.mine !== live.expectedLive)) failed = true;
console.log(
  `R2.4 ingest p95 < ${P95_LIMIT} ms per batch of ${BATCH}: ${failed ? "FAIL" : "PASS"} (p95 ${f(p95)} ms${compactionP95 !== null ? `, during compaction ${f(compactionP95)} ms` : ""})`,
);
process.exitCode = failed ? 1 : 0;
