// Sprint integration check (R1.4, R1.5): the REAL probe daemon (`probe daemon run`, Linux build)
// forwards 500 hook envelopes to the REAL hub image running in docker, and the hub container is
// killed (`docker kill`) and restarted mid-run. The hub keeps its SQLite store on a named volume,
// so rows accepted before the kill survive. Afterwards the hub's REST API is asked for the events.
// Prints `sent=.. accepted=.. duplicates=.. gaps=.. hub_killed_at=.. hub_restarted_at=..` and
// `RESULT pass|fail`.
//   pnpm -F @sessiondeck/probe build && node scripts/harness-integration-hub.mjs
//
// The hub is reached over the docker network by name (cleartext http, non-loopback), so probe.json
// sets allowInsecureHub (the daemon policy in src/daemon/hub-url.ts).
//
// Safety: every docker object is named with PREFIX (default sd-1-S2-); only those names are ever
// touched. Docker image repositories must be lowercase, so the image tag is the lowercased prefix.
// The token is random per run, passed to the container through the environment (not argv), written
// to the temp probe.json, and never printed. Cleanup runs in `finally` and on SIGINT/SIGTERM.
// Env: INT_PREFIX, INT_TOTAL (500), INT_DOWN_MS (10000), INT_NETWORK (sprint-1_default), INT_SKIP_BUILD=1 to reuse an existing image.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killTree, makeUlid } from "./loss-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const PREFIX = process.env.INT_PREFIX ?? "sd-1-S2-";
const NAME = `${PREFIX}hub`;
const VOLUME = `${PREFIX}hubdata`;
const IMAGE = `${PREFIX.toLowerCase()}hub:dev`;
const NETWORK = process.env.INT_NETWORK ?? "sprint-1_default";
const TOTAL = Number(process.env.INT_TOTAL ?? 500);
const DOWN_MS = Number(process.env.INT_DOWN_MS ?? 10_000);
const HOST = "integration-host";
const SESSION = "integration-sess";
const TOKEN = randomBytes(24).toString("base64url");
const AUTH = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, { env, allowFail = false } = {}) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  return (r.stdout ?? "").trim();
}

function cleanupDocker() {
  docker(["rm", "-f", NAME], { allowFail: true });
  docker(["volume", "rm", "-f", VOLUME], { allowFail: true });
}

/** Copies the files the hub Dockerfile needs into a scratch context (legacy builder, no BuildKit). */
function stageContext() {
  const dir = mkdtempSync(join(tmpdir(), "sd-int-ctx-"));
  for (const r of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "packages/contract/package.json",
    "packages/contract/src",
    "packages/contract/tsconfig.json",
    "packages/hub/package.json",
    "packages/hub/src",
    "packages/hub/scripts/bundle.mjs",
    "packages/hub/tsconfig.json",
    "packages/hub/Dockerfile",
  ]) {
    const from = join(repo, r);
    if (!existsSync(from)) throw new Error(`missing build input ${r}`);
    mkdirSync(dirname(join(dir, r)), { recursive: true });
    cpSync(from, join(dir, r), { recursive: true });
  }
  return dir;
}

async function waitHealthy(base, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).status === 200) return Date.now() - t0;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`hub not healthy in ${timeoutMs} ms`);
}

/** All stored events of the harness session, paged by seq. null when the hub is unreachable. */
async function fetchEvents(base) {
  try {
    const out = [];
    let after = null;
    for (;;) {
      const r = await fetch(
        `${base}/sessions/${SESSION}/events?${after === null ? "" : `after=${after}&`}limit=1000`,
        {
          headers: AUTH,
        },
      );
      if (r.status === 404) return out;
      if (r.status !== 200) return null;
      const { events } = await r.json();
      out.push(...events);
      if (events.length < 1000) return out;
      after = events[events.length - 1].seq;
    }
  } catch {
    return null;
  }
}

async function until(cond, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() >= end) return false;
    await sleep(stepMs);
  }
}

let daemon;
let tmpDirs = [];
let cleaned = false;
async function cleanupAll() {
  if (cleaned) return;
  cleaned = true;
  await killTree(daemon);
  cleanupDocker();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanupAll().then(() => process.exit(130)));
}

async function main() {
  const { appendSpoolLines } = await import(
    pathToFileURL(join(root, "dist", "spool-writer.mjs")).href
  );
  cleanupDocker();

  if (process.env.INT_SKIP_BUILD !== "1") {
    const ctx = stageContext();
    tmpDirs.push(ctx);
    const t0 = Date.now();
    docker(["build", "-f", join(ctx, "packages/hub/Dockerfile"), "-t", IMAGE, ctx], {
      env: { DOCKER_BUILDKIT: "0" },
    });
    console.log(`# docker build ${IMAGE} ok in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  // The harness runs inside a sprint container on a docker network, so the hub joins that network
  // and is reached by container name (a published host port is not reachable from here).
  const base = `http://${NAME}:8787`;
  // Store: HUB_DB_PATH=/data/hub.sqlite (image default) on the named volume, so it is the SQLite
  // file store, not the in-memory one, and survives `docker kill` + `docker start`.
  docker(["volume", "create", VOLUME]);
  docker(
    [
      "run",
      "-d",
      "--name",
      NAME,
      "--network",
      NETWORK,
      "-v",
      `${VOLUME}:/data`,
      "-e",
      "HUB_TOKEN",
      "-e",
      "HUB_BIND=0.0.0.0",
      IMAGE,
    ],
    { env: { HUB_TOKEN: TOKEN } },
  );
  console.log(`# hub healthy after ${await waitHealthy(base)} ms at ${base}`);

  const home = mkdtempSync(join(tmpdir(), "sd-int-home-"));
  const claudeDir = mkdtempSync(join(tmpdir(), "sd-int-claude-"));
  tmpDirs.push(home, claudeDir);
  writeFileSync(
    join(home, "probe.json"),
    JSON.stringify({ hubUrl: base, token: TOKEN, host: HOST, allowInsecureHub: true }),
  );
  daemon = spawn(
    process.execPath,
    [join(root, "dist", "probe.mjs"), "daemon", "run", "--home", home],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let daemonErr = "";
  daemon.stderr.on("data", (d) => (daemonErr = (daemonErr + d).slice(-2000)));

  let sent = 0;
  const write = (n) => {
    const ts = Date.now();
    appendSpoolLines(join(home, "spool"), [
      {
        v: 1,
        id: makeUlid(ts, n),
        kind: "hook",
        host: HOST,
        os: "linux",
        session_id: SESSION,
        hook_event_name: "PostToolUse",
        ts,
        payload: { n, pad: "x".repeat(200) },
      },
    ]);
    sent += 1;
  };
  const stored = async () => (await fetchEvents(base))?.length ?? 0;

  // Phase 1: first third, paced at 10 ms per line (about 1.7 s), until the hub holds a third.
  const third = Math.floor(TOTAL / 3);
  let n = 0;
  while (n < third) {
    write(n++);
    await sleep(10);
  }
  if (!(await until(async () => (await stored()) >= third, 30_000))) {
    const logs = docker(["logs", "--tail", "400", NAME], { allowFail: true });
    throw new Error(
      `hub never accepted the first third; daemon stderr: ${daemonErr}\nhub logs: ${logs
        .split("\n")
        .filter((l) => !l.includes("GET") && !l.includes('"statusCode":404'))
        .slice(-8)
        .join("\n")}`,
    );
  }

  // Phase 2: kill the hub, keep writing for DOWN_MS.
  const acceptedAtKill = await stored().catch(() => 0);
  docker(["kill", NAME]);
  const killedAt = Date.now();
  const interval = Math.max(5, Math.min(100, Math.floor((DOWN_MS * 0.6) / (TOTAL - n))));
  while (n < TOTAL && Date.now() - killedAt < DOWN_MS * 0.6) {
    write(n++);
    await sleep(interval);
  }
  const left = DOWN_MS - (Date.now() - killedAt);
  if (left > 0) await sleep(left);
  while (n < TOTAL) write(n++);

  // Phase 3: restart (same container, same volume, same published port) and wait for the drain.
  docker(["start", NAME]);
  const restartedAt = Date.now();
  await waitHealthy(base);
  const drained = await until(async () => (await stored()) >= TOTAL, 120_000, 250);
  const drainMs = Date.now() - restartedAt;
  await sleep(2000); // time for any duplicate to show up

  const events = (await fetchEvents(base)) ?? [];
  const ids = new Set(events.map((e) => e.id));
  const seqs = new Set(events.map((e) => `${e.host}/${e.seq}`));
  const ns = new Set(events.map((e) => e.payload?.n));
  const duplicates =
    events.length - ids.size + (events.length - seqs.size) + (events.length - ns.size);
  let gaps = 0;
  for (let i = 0; i < TOTAL; i++) if (!ns.has(i)) gaps++;
  const sortedSeq = events.map((e) => e.seq).sort((a, b) => a - b);
  const seqGaps = sortedSeq.filter((s, i) => i > 0 && s !== sortedSeq[i - 1] + 1).length;
  console.log(
    `# accepted_before_kill=${acceptedAtKill} drain_ms=${drainMs} seq_gaps=${seqGaps} (heartbeat envelopes share the host seq space) order_by_seq_matches_n=${events.every((e, i) => i === 0 || e.payload.n > events[i - 1].payload.n)}`,
  );
  console.log(
    `sent=${sent} accepted=${events.length} duplicates=${duplicates} gaps=${gaps} hub_killed_at=${killedAt} hub_restarted_at=${restartedAt}`,
  );
  return drained && sent === TOTAL && events.length === TOTAL && duplicates === 0 && gaps === 0;
}

let pass = false;
try {
  pass = await main();
} catch (e) {
  console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanupAll();
}
console.log(`RESULT ${pass ? "pass" : "fail"}`);
process.exit(pass ? 0 : 1);
