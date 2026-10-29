// Phase 5 integration check (R5.2, R5.3): "20 fixture vault files import idempotently in under 10 s;
// live record merges with its archive by session_id". The REAL probe daemon code (startDaemon plus
// the ArchiveComponent, bundled with esbuild from src/, no mocks) ships to the REAL hub image
// running in docker (SQLite on a named volume). Hub state is read back over REST and, for the row
// state `archived`, with a read-only better-sqlite3 query inside the hub container.
//
//   a) 22 fixture captures (vault/ + projects/) are copied into a temp vault and imported: one hub
//      row per file, wall time recorded (scan start until the 22nd row is visible at the hub).
//   b) second scan unchanged: 0 shipped, rows identical. One file rewritten with a newer mtime:
//      exactly 1 shipped and only that row changes.
//   c) merge, both arrival orders: live hook events (SessionStart..SessionEnd) then a capture for the
//      same session_id -> ONE record with live fields and archive fields, row state archived; and
//      capture first, live events second.
//   d) report-only probe of the hub reviewer LOW: a backlog live envelope OLDER than the capture end
//      arrives after the archive shipped; does the row stay archived? (`backlog_regress`)
//
// Prints evidence lines (files=, wall_ms=, shipped_run1=, shipped_run2=, shipped_touch=, rows=,
// merged_live_first=, merged_archive_first=, backlog_regress=) and `RESULT pass|fail`; exit 1 on fail.
//   node scripts/harness-archive-hub.mjs        (needs docker; builds the hub image)
// Env: INT_STRICT_BACKLOG=1 turns backlog_regress into a failed check (default informational),
// INT_PREFIX (sd-3-S9b-), INT_NETWORK (sprint-3_default), INT_SKIP_BUILD=1 to reuse the image,
// INT_KEEP_IMAGE=1 to keep it, INT_PUBLISH_PORT to reach the hub on 127.0.0.1:<port> instead of by
// container name on INT_NETWORK.
//
// Safety: every docker object is named with PREFIX; only those names are touched. The token is
// random per run, passed through the environment (not argv) and never printed. Cleanup runs in
// `finally` and on SIGINT/SIGTERM.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const fixtures = join(repo, "packages", "contract", "fixtures");
const PREFIX = process.env.INT_PREFIX ?? "sd-3-S9b-";
const NETWORK = process.env.INT_NETWORK ?? "sprint-3_default";
if (!/^sd-\d+-[A-Za-z0-9]+-$/.test(PREFIX)) throw new Error(`INT_PREFIX rejected: ${PREFIX}`);
if (!/^sprint-\d+_default$/.test(NETWORK)) throw new Error(`INT_NETWORK rejected: ${NETWORK}`);
const NAME = `${PREFIX}hub`;
const VOLUME = `${PREFIX}hubdata`;
const IMAGE = `${PREFIX.toLowerCase()}hub:dev`;
const HOST = "archive-harness";
const TOKEN = randomBytes(24).toString("base64url");
const AUTH = { authorization: `Bearer ${TOKEN}` };
const LIMIT_MS = 10_000;
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
  if (process.env.INT_SKIP_BUILD !== "1" && process.env.INT_KEEP_IMAGE !== "1") {
    docker(["rmi", "-f", IMAGE], { allowFail: true });
  }
}

/** Copies the files the hub Dockerfile needs into a scratch context (legacy builder, no BuildKit). */
function stageContext() {
  const dir = mkdtempSync(join(tmpdir(), "sd-arch-ctx-"));
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

async function until(cond, timeoutMs, stepMs = 50) {
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
  try {
    await daemon?.kill();
  } catch {
    // best effort
  }
  cleanupDocker();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanupAll().then(() => process.exit(130)));
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
};

/** Bundles the real daemon, archive component, envelope builder and spool writer. */
async function loadProbe() {
  const dir = mkdtempSync(join(tmpdir(), "sd-arch-bundle-"));
  tmpDirs.push(dir);
  await build({
    absWorkingDir: root,
    stdin: {
      contents: [
        'export { startDaemon } from "./src/daemon/index.ts";',
        'export { ArchiveComponent } from "./src/daemon/archive.ts";',
        'export { buildEnvelope } from "./src/envelope.ts";',
        'export { appendSpoolLines } from "./src/spool-writer.ts";',
        'export { spoolDir } from "./src/paths.ts";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    outfile: join(dir, "probe.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "warning",
  });
  return import(pathToFileURL(join(dir, "probe.mjs")).href);
}

function walkMd(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walkMd(dir, r));
    else if (/^(projects|harness)\/.+\/sessions\/.+\.md$/.test(r)) out.push(r);
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
function capture({ id, title, startMs, endMs, outcome }) {
  return [
    "---",
    "schema_version: 2",
    `session_id: ${id}`,
    `title: ${title}`,
    `date: ${iso(startMs).slice(0, 10)}`,
    `started_at: ${iso(startMs)}`,
    `ended_at: ${iso(endMs)}`,
    "tools_used:",
    "  - Read: 3",
    "  - Edit: 1",
    "commits:",
    "  - abc1234 Merge test",
    "prs: []",
    "---",
    "",
    outcome,
    "",
  ].join("\n");
}

async function main() {
  const probe = await loadProbe();
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

  const publish = process.env.INT_PUBLISH_PORT;
  const base = publish ? `http://127.0.0.1:${publish}` : `http://${NAME}:8787`;
  docker(["volume", "create", VOLUME]);
  docker(
    [
      "run",
      "-d",
      "--name",
      NAME,
      ...(publish ? ["-p", `127.0.0.1:${publish}:8787`] : ["--network", NETWORK]),
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

  const get = async (path) => {
    const r = await fetch(`${base}${path}`, { headers: AUTH });
    return r.status === 200 ? await r.json() : r.status === 404 ? null : undefined;
  };
  const allSessions = async () => (await get("/sessions?limit=1000")) ?? [];
  const archivedRows = async () => (await allSessions()).filter((s) => s.archive !== undefined);
  const rowState = (id) => {
    const js =
      "const D=require('/app/node_modules/better-sqlite3');" +
      "const d=new D('/data/hub.sqlite',{readonly:true});" +
      `const r=d.prepare('SELECT state FROM sessions WHERE session_id=?').all(${JSON.stringify(id)});` +
      "console.log(JSON.stringify(r.map(x=>x.state)))";
    try {
      return JSON.parse(docker(["exec", NAME, "node", "-e", js]));
    } catch {
      return null;
    }
  };
  const liveIds = async () =>
    ((await get("/sessions?live=1&limit=1000")) ?? []).map((s) => s.session_id);

  // Vault: the 22 golden captures (20 harness + 2 projects) copied into a temp vault.
  const work = mkdtempSync(join(tmpdir(), "sd-arch-work-"));
  tmpDirs.push(work);
  const vault = join(work, "vault");
  const files = walkMd(join(fixtures, "vault"));
  for (const rel of files) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    cpSync(join(fixtures, "vault", rel), join(vault, rel));
  }
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });

  const archive = new probe.ArchiveComponent({
    config: { roots: [{ label: "vault", path: vault }], intervalSec: 3600 },
    statePath: join(home, "daemon", "archive-index.json"),
    initialDelayMs: 24 * 3600 * 1000, // scans are triggered by the harness, never by the timer
  });
  let archiveCtx;
  const origStart = archive.start.bind(archive);
  archive.start = (ctx) => {
    archiveCtx = ctx;
    return origStart(ctx);
  };
  daemon = await probe.startDaemon({
    home,
    config: { hubUrl: base, token: TOKEN, host: HOST, allowInsecureHub: true },
    components: [archive],
    heartbeatMs: 0,
    pollMs: 20,
    batchMs: 100,
    stderr: false,
  });
  if (!daemon) throw new Error("daemon did not start (lock held)");

  // ---- a) first import
  const t0 = performance.now();
  const s1 = await archive.runOnce();
  const gotAll = await until(async () => (await archivedRows()).length >= files.length, 30_000);
  const wallMs = Math.round(performance.now() - t0);
  const rows1 = (await archivedRows()).sort((a, b) => a.session_id.localeCompare(b.session_id));
  console.log(`# scan1 ${JSON.stringify({ scanned: s1.scanned, shipped: s1.shipped, ms: s1.ms })}`);
  check(
    "a: one hub row per fixture file",
    gotAll && rows1.length === files.length,
    `${rows1.length}/${files.length}`,
  );
  check("a: ids distinct", new Set(rows1.map((r) => r.session_id)).size === files.length);
  check("a: wall under 10 s", wallMs < LIMIT_MS, `${wallMs} ms`);
  const withOutcome = rows1.filter((r) => typeof r.archive?.outcome === "string").length;
  check(
    "a: rows carry archive fields",
    withOutcome === files.length,
    `${withOutcome} with outcome`,
  );

  // ---- b) idempotent + incremental
  await sleep(1500);
  const s2 = await archive.runOnce();
  await sleep(1500);
  const rows2 = (await archivedRows()).sort((a, b) => a.session_id.localeCompare(b.session_id));
  const identical = JSON.stringify(rows1) === JSON.stringify(rows2);
  check(
    "b: second run ships 0",
    s2.shipped === 0 && s2.unchanged === files.length,
    `shipped=${s2.shipped} unchanged=${s2.unchanged}`,
  );
  check("b: hub rows identical after rerun", identical);

  const victim = files.find((f) => f.endsWith("probe-spool.md"));
  const vAbs = join(vault, victim);
  const vText = readFileSync(vAbs, "utf8");
  const newer = new Date(Date.now() + 5000);
  writeFileSync(vAbs, vText.replace(/^title: .*$/m, "title: Retitled by harness"));
  utimesSync(vAbs, newer, newer);
  const s3 = await archive.runOnce();
  const vId = /session_id: (\S+)/.exec(vText)[1];
  const updated = await until(
    async () => (await get(`/sessions/${vId}`))?.archive?.title === "Retitled by harness",
    15_000,
  );
  await sleep(500);
  const rows3 = (await archivedRows()).sort((a, b) => a.session_id.localeCompare(b.session_id));
  const changed = rows3.filter((r, i) => JSON.stringify(r) !== JSON.stringify(rows2[i]));
  check("b: touched file ships exactly 1", s3.shipped === 1, `shipped=${s3.shipped}`);
  check(
    "b: only that row changed",
    updated && changed.length === 1 && changed[0].session_id === vId,
    `changed=${changed.length}`,
  );
  check("b: row count unchanged", rows3.length === files.length);

  // ---- b2) hub-side idempotence: a lost index re-ships every capture; the hub must not change
  const evCount = async (id) =>
    ((await get(`/sessions/${id}/events?limit=1000`))?.events ?? []).length;
  const snapshotHub = async (rows) => ({
    states: rows.map((r) => JSON.stringify(rowState(r.session_id))),
    events: await Promise.all(rows.map((r) => evCount(r.session_id))),
  });
  const before = await snapshotHub(rows3);
  const archive2 = new probe.ArchiveComponent({
    config: { roots: [{ label: "vault", path: vault }], intervalSec: 3600 },
    statePath: join(home, "daemon", "archive-index-fresh.json"),
    initialDelayMs: 24 * 3600 * 1000,
  });
  archive2.start(archiveCtx);
  const s4 = await archive2.runOnce();
  await sleep(3000);
  const rows4 = (await archivedRows()).sort((a, b) => a.session_id.localeCompare(b.session_id));
  const after = await snapshotHub(rows4);
  await archive2.stop();
  check(
    "b2: fresh index re-ships every capture",
    s4.shipped === files.length,
    `shipped=${s4.shipped}`,
  );
  check(
    "b2: hub rows byte-identical after re-ship",
    JSON.stringify(rows3) === JSON.stringify(rows4),
  );
  check("b2: row states unchanged", JSON.stringify(before.states) === JSON.stringify(after.states));
  check(
    "b2: event counts unchanged",
    JSON.stringify(before.events) === JSON.stringify(after.events),
    `events=${after.events.reduce((a, b) => a + b, 0)}`,
  );

  // ---- c) merge, live first
  const now = Date.now();
  const hookFixture = (dir, name) => JSON.parse(readFileSync(join(fixtures, dir, name), "utf8"));
  const seqLive = (id, cwd, baseTs) => {
    const mk = (event, dir, name, dt, extra = {}) =>
      probe.buildEnvelope({
        kind: "hook",
        host: HOST,
        session_id: id,
        hook_event_name: event,
        payload: { ...hookFixture(dir, name), session_id: id, cwd, ...extra },
        ts: baseTs + dt,
      });
    return [
      mk("SessionStart", "SessionStart", "01-startup.json", 0),
      mk("UserPromptSubmit", "UserPromptSubmit", "01-sample.json", 1000),
      mk("Stop", "Stop", "01-after-ask.json", 2000),
      mk("SessionEnd", "SessionEnd", "01-other.json", 3000),
    ];
  };
  const spool = probe.spoolDir(home);
  const sendLive = (envs) => probe.appendSpoolLines(spool, envs);

  const idA = randomUUID();
  const cwdA = "/home/dev/live-first";
  const liveA = seqLive(idA, cwdA, now - 20_000);
  sendLive(liveA);
  const liveSeen = await until(
    async () => (await get(`/sessions/${idA}`))?.state === "ended",
    15_000,
  );
  const snapLive = await get(`/sessions/${idA}`);
  check(
    "c1: live events reached the hub (ended, no archive yet)",
    liveSeen && snapLive?.archive === undefined,
  );
  const outcomeA = "Merged outcome A. Live record then capture.";
  const pathA = join(vault, "harness", "agentic-harness", "sessions", "2026-10-28-live-first.md");
  writeFileSync(
    pathA,
    capture({
      id: idA,
      title: "Live first",
      startMs: now - 20_000,
      endMs: now - 17_000,
      outcome: outcomeA,
    }),
  );
  const sA = await archive.runOnce();
  const mergedA = await until(
    async () => (await get(`/sessions/${idA}`))?.archive !== undefined,
    15_000,
  );
  const snapA = await get(`/sessions/${idA}`);
  const occA = (await allSessions()).filter((s) => s.session_id === idA).length;
  const stateA = rowState(idA);
  const liveFieldsA =
    snapA?.cwd === cwdA &&
    snapA?.started_at === snapLive?.started_at &&
    snapA?.last_event_at >= now - 20_000;
  const archFieldsA =
    snapA?.archive?.outcome === outcomeA && snapA?.archive?.title === "Live first";
  const mergedLiveFirst =
    sA.shipped === 1 &&
    mergedA &&
    occA === 1 &&
    liveFieldsA &&
    archFieldsA &&
    stateA?.[0] === "archived";
  check(
    "c1: merged into one record, live + archive fields, row state archived",
    mergedLiveFirst,
    `records=${occA} cwd=${snapA?.cwd} state=${JSON.stringify(stateA)} snapshot.state=${snapA?.state}`,
  );
  check("c1: archived row is off the live board", !(await liveIds()).includes(idA));

  // ---- d) report-only: older backlog live envelope after the archive shipped
  const regressId = idA;
  const old = probe.buildEnvelope({
    kind: "hook",
    host: HOST,
    session_id: regressId,
    hook_event_name: "UserPromptSubmit",
    payload: {
      ...hookFixture("UserPromptSubmit", "01-sample.json"),
      session_id: regressId,
      cwd: cwdA,
      // differs from the live prompt: the hub drops same-signature events as duplicates
      prompt: "backlog prompt",
      prompt_id: randomUUID(),
    },
    ts: now - 19_500, // before the capture end (now - 17 s) and before the live SessionEnd
  });
  sendLive([old]);
  await sleep(2500);
  const afterOld = await get(`/sessions/${regressId}`);
  const evs = (await get(`/sessions/${regressId}/events?limit=1000`))?.events ?? [];
  check(
    "d: the older backlog envelope was stored by the hub",
    evs.filter((e) => e.hook_event_name === "UserPromptSubmit").length === 2,
    `events=${evs.length} ${evs.map((e) => e.hook_event_name).join(",")}`,
  );
  const stateAfter = rowState(regressId);
  const stillArchived =
    stateAfter?.[0] === "archived" &&
    afterOld?.archive !== undefined &&
    !(await liveIds()).includes(regressId);
  const backlogRegress = !stillArchived;
  console.log(
    `# backlog detail: row_state=${JSON.stringify(stateAfter)} snapshot.state=${afterOld?.state} archive_kept=${afterOld?.archive !== undefined}`,
  );

  // ---- d2) report-only: backlog envelope between the live end and the capture end
  const idC = randomUUID();
  const t2 = Date.now();
  sendLive(seqLive(idC, "/home/dev/backlog-late", t2 - 120_000)); // live ends at t2 - 117 s
  await until(async () => (await get(`/sessions/${idC}`))?.state === "ended", 15_000);
  const pathC = join(vault, "harness", "agentic-harness", "sessions", "2026-10-28-backlog-late.md");
  writeFileSync(
    pathC,
    capture({
      id: idC,
      title: "Backlog late",
      startMs: t2 - 120_000,
      endMs: t2 - 30_000,
      outcome: "Capture runs past the live end.",
    }),
  );
  await archive.runOnce();
  await until(async () => (await get(`/sessions/${idC}`))?.archive !== undefined, 15_000);
  sendLive([
    probe.buildEnvelope({
      kind: "hook",
      host: HOST,
      session_id: idC,
      hook_event_name: "UserPromptSubmit",
      payload: {
        ...hookFixture("UserPromptSubmit", "01-sample.json"),
        session_id: idC,
        cwd: "/home/dev/backlog-late",
        prompt: "late backlog prompt",
        prompt_id: randomUUID(),
      },
      ts: t2 - 60_000, // after the live SessionEnd, before the capture end
    }),
  ]);
  await sleep(2500);
  const afterLate = await get(`/sessions/${idC}`);
  const stateLate = rowState(idC);
  const lateRegress = !(stateLate?.[0] === "archived" && !(await liveIds()).includes(idC));
  console.log(
    `# backlog_late detail: row_state=${JSON.stringify(stateLate)} snapshot.state=${afterLate?.state} archive_kept=${afterLate?.archive !== undefined}`,
  );

  // ---- c) merge, archive first
  const idB = randomUUID();
  const cwdB = "/home/dev/archive-first";
  const t1 = Date.now();
  const outcomeB = "Merged outcome B. Capture then live record.";
  const pathB = join(
    vault,
    "harness",
    "agentic-harness",
    "sessions",
    "2026-10-28-archive-first.md",
  );
  writeFileSync(
    pathB,
    capture({
      id: idB,
      title: "Archive first",
      startMs: t1 - 30_000,
      endMs: t1 - 20_000,
      outcome: outcomeB,
    }),
  );
  const sB = await archive.runOnce();
  const archOnly = await until(
    async () => (await get(`/sessions/${idB}`))?.archive !== undefined,
    15_000,
  );
  const snapB0 = await get(`/sessions/${idB}`);
  check(
    "c2: archive-only record appears first",
    sB.shipped === 1 && archOnly && snapB0?.state === "ended",
    `state=${snapB0?.state}`,
  );
  sendLive(seqLive(idB, cwdB, t1 - 10_000));
  const liveB = await until(async () => (await get(`/sessions/${idB}`))?.cwd === cwdB, 15_000);
  await sleep(1000);
  const snapB = await get(`/sessions/${idB}`);
  const occB = (await allSessions()).filter((s) => s.session_id === idB).length;
  const stateB = rowState(idB);
  const mergedArchiveFirst =
    liveB &&
    occB === 1 &&
    snapB?.cwd === cwdB &&
    snapB?.archive?.outcome === outcomeB &&
    snapB?.archive?.title === "Archive first" &&
    stateB?.[0] === "archived";
  check(
    "c2: merged into one record, live + archive fields, row state archived",
    mergedArchiveFirst,
    `records=${occB} cwd=${snapB?.cwd} state=${JSON.stringify(stateB)} snapshot.state=${snapB?.state}`,
  );

  // Rescan with the persisted index after the merges: nothing changed on disk, so nothing ships.
  const sC = await archive.runOnce();
  check("c: rescan after merges ships 0", sC.shipped === 0, `shipped=${sC.shipped}`);

  const total = (await archivedRows()).length;
  console.log(
    `files=${files.length} wall_ms=${wallMs} shipped_run1=${s1.shipped} shipped_run2=${s2.shipped} shipped_touch=${s3.shipped} rows=${rows1.length}`,
  );
  console.log(
    `merged_live_first=${mergedLiveFirst} merged_archive_first=${mergedArchiveFirst} backlog_regress=${backlogRegress || lateRegress} backlog_regress_older_than_live=${backlogRegress} backlog_regress_late=${lateRegress} rows_after_merges=${total}`,
  );
  if (process.env.INT_STRICT_BACKLOG === "1") {
    check("d: backlog envelope older than live end keeps the archived state", !backlogRegress);
    check("d2: backlog envelope past the live end keeps the archived state", !lateRegress);
  }
  return checks.every((c) => c.ok) && files.length >= 20;
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
