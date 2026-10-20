// Shared by scripts/harness-loss.mjs and test/daemon-loss.proc.test.ts (R1.4, R1.5).
// A stub hub (records POST /ingest, dedupes by id, can be stopped and restarted on the same port,
// can answer 5xx, can lose an ack) plus the scenarios that drive the BUILT daemon (dist/daemon.mjs)
// against it while envelopes are written through the real spool writer (dist/spool-writer.mjs).
// Everything lives under a temp probe home. Needs `pnpm -F @sessiondeck/probe build` first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const daemonPath = join(root, "dist", "daemon.mjs");
const writerPath = join(root, "dist", "spool-writer.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID with a fixed 80-bit tail: unique and sortable per (ts, n). */
export function makeUlid(ts, n) {
  let t = "";
  for (let i = 0, x = ts; i < 10; i++, x = Math.floor(x / 32)) t = CROCKFORD[x % 32] + t;
  let tail = "";
  for (let i = 0, x = n; i < 6; i++, x = Math.floor(x / 32)) tail = CROCKFORD[x % 32] + tail;
  const rnd = randomBytes(10);
  let r = "";
  for (const b of rnd) r += CROCKFORD[b % 32];
  return t + r + tail;
}

export class StubHub {
  constructor({ token = "tok-test", port = 0 } = {}) {
    this.token = token;
    this.port = port;
    /** id -> { seq, host } for every distinct envelope the hub stored. */
    this.accepted = new Map();
    /** ids in the order the hub first stored them. */
    this.order = [];
    this.requests = 0;
    this.resentIds = 0; // ids received again (a lost ack or a restart); absorbed by dedup
    this.conflicts = 0; // same id with another seq, or one seq under two ids: real corruption
    this.responseDelayMs = 0;
    this.fail5xx = 0; // next N requests answer 503 without storing
    this.dropAcks = 0; // next N requests are stored, then the connection is cut with no response
    this.server = undefined;
    this.seqToId = new Map();
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
  }

  /** The hub dies: sockets are cut, stored data survives (it is the database). */
  async stop() {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    await new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  async #handle(req, res) {
    this.requests += 1;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (this.responseDelayMs > 0) await sleep(this.responseDelayMs);
    if (req.method !== "POST" || req.url !== "/ingest") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    if (this.fail5xx > 0) {
      this.fail5xx -= 1;
      res.writeHead(503).end();
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    let last = -1;
    for (const env of body.envelopes) {
      const prev = this.accepted.get(env.id);
      if (prev) {
        this.resentIds += 1;
        if (prev.seq !== env.seq) this.conflicts += 1;
        continue;
      }
      if (this.seqToId.has(`${body.host}:${env.seq}`)) this.conflicts += 1;
      this.seqToId.set(`${body.host}:${env.seq}`, env.id);
      this.accepted.set(env.id, {
        seq: env.seq,
        host: body.host,
        kind: env.kind,
        payload: env.payload,
      });
      this.order.push(env.id);
      last = env.seq;
    }
    if (this.dropAcks > 0) {
      this.dropAcks -= 1;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: body.envelopes.length, last_seq: Math.max(last, 0) }));
  }

  /** Counts "n" payloads (the writer's index) of non-heartbeat envelopes. */
  analyze(sent) {
    const mine = [];
    const seqs = [];
    for (const id of this.order) {
      const a = this.accepted.get(id);
      seqs.push(a.seq);
      if (a.kind === "hook") mine.push(a);
    }
    const indexes = mine.map((a) => a.payload.n);
    const unique = new Set(indexes);
    const sorted = [...seqs].sort((x, y) => x - y);
    let gaps = 0;
    for (let i = 0; i < sorted.length; i++) if (sorted[i] !== i) gaps += 1;
    let inOrder = true;
    for (let i = 1; i < mine.length; i++) {
      if (!(mine[i].payload.n > mine[i - 1].payload.n && mine[i].seq > mine[i - 1].seq))
        inOrder = false;
    }
    // Arrival order of stored seq must also be increasing (nothing delivered out of order).
    for (let i = 1; i < seqs.length; i++) if (seqs[i] < seqs[i - 1]) inOrder = false;
    return {
      sent,
      accepted: mine.length,
      duplicates: this.conflicts + (mine.length - unique.size),
      gaps,
      order: inOrder ? "ok" : "BROKEN",
      resent_ids: this.resentIds,
      total_stored: this.accepted.size,
    };
  }
}

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
    } else child.kill("SIGKILL");
  });
}

export function spawnDaemon(home, env = {}) {
  const child = spawn(process.execPath, [daemonPath, "--home", home], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", () => undefined);
  return child;
}

export function makeHome(hub) {
  const home = mkdtempSync(join(tmpdir(), "sd-loss-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "probe.json"),
    JSON.stringify({ hubUrl: hub.url, token: hub.token, host: "loss-host" }),
  );
  return home;
}

async function loadWriter() {
  return import(pathToFileURL(writerPath).href);
}

/** Writes envelopes [from, to) through the real spool writer, `burst` per append, `gapMs` apart. */
async function writeRange(home, appendSpoolLines, from, to, burst, gapMs) {
  const dir = join(home, "spool");
  for (let i = from; i < to; i += burst) {
    const lines = [];
    for (let n = i; n < Math.min(to, i + burst); n++) {
      const ts = Date.now();
      lines.push({
        v: 1,
        id: makeUlid(ts, n),
        kind: "hook",
        host: "loss-host",
        os: process.platform === "win32" ? "win32" : "linux",
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        ts,
        payload: { n, pad: "x".repeat(200) },
      });
    }
    appendSpoolLines(dir, lines);
    if (gapMs > 0) await sleep(gapMs);
  }
}

async function until(cond, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function realCount(hub) {
  let n = 0;
  for (const a of hub.accepted.values()) if (a.kind === "hook") n += 1;
  return n;
}

const DAEMON_ENV = { SESSIONDECK_BACKOFF_CAP_MS: "1500", SESSIONDECK_HEARTBEAT_MS: "700" };

/**
 * R1.4: 500 envelopes written during load; the daemon is SIGKILLed (taskkill /F on Windows) three
 * times, the last while a response is delayed so a batch is in flight with an unacked journal; the
 * hub is killed and restarted once; one ack is lost. Returns hub.analyze(500).
 */
export async function runKillScenario({ total = 500, timeoutMs = 60_000 } = {}) {
  const { appendSpoolLines } = await loadWriter();
  const hub = new StubHub();
  await hub.start();
  const home = makeHome(hub);
  let d = spawnDaemon(home, DAEMON_ENV);
  hub.responseDelayMs = 120;
  hub.dropAcks = 1;
  let kills = 0;
  try {
    const writer = writeRange(home, appendSpoolLines, 0, total, 10, 60);
    const chaos = (async () => {
      await sleep(700);
      await killTree(d);
      kills += 1;
      d = spawnDaemon(home, DAEMON_ENV);
      await sleep(900);
      await hub.stop();
      await sleep(1200);
      await hub.start();
      await sleep(600);
      await killTree(d);
      kills += 1;
      d = spawnDaemon(home, DAEMON_ENV);
      await sleep(500);
      await killTree(d); // mid-flight again (responses are slow)
      kills += 1;
      d = spawnDaemon(home, DAEMON_ENV);
    })();
    await Promise.all([writer, chaos]);
    hub.responseDelayMs = 0;
    await until(() => realCount(hub) >= total, timeoutMs);
    // A little extra time for any duplicate delivery to show up.
    await sleep(500);
    return { ...hub.analyze(total), daemon_kills: kills, requests: hub.requests };
  } finally {
    await killTree(d);
    await hub.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * R1.5: the hub is unreachable for `outageMs` (a compressed stand-in for 10 minutes; the retry
 * cap is also shortened, see DAEMON_ENV) while envelopes keep being written, then comes back on
 * the same port. Everything must arrive in order. Returns hub.analyze(total) plus timings.
 */
export async function runOutageScenario({
  total = 500,
  outageMs = 15_000,
  timeoutMs = 60_000,
} = {}) {
  const { appendSpoolLines } = await loadWriter();
  const hub = new StubHub();
  await hub.start();
  const home = makeHome(hub);
  const d = spawnDaemon(home, DAEMON_ENV);
  try {
    await writeRange(home, appendSpoolLines, 0, 50, 10, 20);
    await until(() => realCount(hub) >= 50, 20_000);
    const before = realCount(hub);
    await hub.stop();
    const t0 = Date.now();
    const perBurst = Math.max(1, Math.ceil((total - 50) / (outageMs / 100)));
    await writeRange(home, appendSpoolLines, 50, total, perBurst, 100);
    const wait = outageMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const during = realCount(hub);
    await hub.start();
    const t1 = Date.now();
    const ok = await until(() => realCount(hub) >= total, timeoutMs);
    const recoverMs = Date.now() - t1;
    await sleep(500);
    return {
      ...hub.analyze(total),
      outage_ms: outageMs,
      delivered_before_outage: before,
      delivered_during_outage: during - before,
      recovered: ok,
      recover_ms: recoverMs,
    };
  } finally {
    await killTree(d);
    await hub.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
