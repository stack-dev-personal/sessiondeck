#!/usr/bin/env node
// Atlas restart harness (R5.1, R5.5, R5.6, R5.4). Starts the real hub (bundled from src/main.ts) on
// a temp SQLite file with a random throwaway token, ingests contract fixture envelopes (one session
// in a repo, one in a worktree of the same repo, one elsewhere), PATCHes a phase, restarts the hub on
// the same database, prints GET /projects/:id and /sessions/:id, runs /search and prints took_ms.
// Exits non-zero on any mismatch. Temp files are removed. Usage: node scripts/atlas-harness.mjs
// (bundles into dist/ itself; no prior build needed).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hubDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(hubDir, "..", "contract", "fixtures");
const bundle = path.join(hubDir, "dist", "atlas-harness-main.mjs");
const tmp = mkdtempSync(path.join(os.tmpdir(), "sd-atlas-harness-"));
const dbPath = path.join(tmp, "hub.sqlite");
const token = randomBytes(18).toString("hex");
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => {
  const b = randomBytes(26);
  let s = "0";
  for (let i = 0; i < 25; i++) s += B32[b[i] % 32];
  return s;
};
const fx = (rel) => JSON.parse(readFileSync(path.join(fixtures, rel), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// The hub child gets only what it needs to run, not the caller's whole environment.
function minimalEnv() {
  const keep = ["PATH", "HOME", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE"];
  return Object.fromEntries(
    keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
}

let child = null;
let base = "";
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
};

async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [bundle], {
    cwd: hubDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...minimalEnv(),
      HUB_TOKEN: token,
      HUB_PORT: String(port),
      HUB_DB_PATH: dbPath,
      HUB_PRICING_FETCH: "0",
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) throw new Error(`hub exited with ${child.exitCode}`);
    await sleep(100);
  }
  throw new Error("hub did not start");
}
async function stop() {
  if (child === null || child.exitCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
}
const get = async (p) => {
  const r = await fetch(base + p, { headers: auth });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

let seq = 0;
const env = (sid, cwd, hook, payload) => ({
  v: 1,
  id: ulid(),
  kind: "hook",
  host: "harness",
  os: "linux",
  session_id: sid,
  hook_event_name: hook,
  ts: Date.now() + seq * 10,
  seq: ++seq,
  payload: { ...payload, session_id: sid, cwd },
});

async function main() {
  const b = spawnSync(
    process.execPath,
    ["scripts/bundle.mjs", "src/main.ts", path.relative(hubDir, bundle)],
    {
      cwd: hubDir,
      stdio: "inherit",
    },
  );
  if (b.status !== 0) throw new Error("bundling the hub failed");

  const startPayload = fx("SessionStart/01-startup.json");
  // Fixture prompts are scrubbed ("<TEXT n>"); this one carries searchable text.
  const prompt = {
    ...fx("UserPromptSubmit/01-sample.json"),
    prompt: "investigate the flaky zebra websocket",
  };
  const REPO = "/home/u/code/demoapp";
  const sessions = {
    main: ["h-main", REPO],
    wt: ["h-wt", `${REPO}/.claude/worktrees/feat-x`],
    other: ["h-other", "/home/u/code/other"],
  };
  await start();
  const envs = Object.values(sessions).flatMap(([sid, cwd]) => [
    env(sid, cwd, "SessionStart", startPayload),
    env(sid, cwd, "UserPromptSubmit", prompt),
  ]);
  const ing = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ host: "harness", envelopes: envs }),
  });
  console.log("ingest", ing.status);
  check("ingest accepted", ing.status === 200);

  const main0 = await get("/sessions/h-main");
  const wt0 = await get("/sessions/h-wt");
  const pid = main0.project_id;
  check("worktree rolls up to the repo project", pid !== null && wt0.project_id === pid);
  const pr = await fetch(`${base}/sessions/h-wt/phase`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ phase: "Phase 5 - Atlas" }),
  });
  check("PATCH phase", pr.status === 200);

  await stop();
  console.log("-- hub stopped, restarting on the same database --");
  await start();

  const proj = await get(`/projects/${pid}`);
  const wt = await get("/sessions/h-wt");
  const other = await get("/sessions/h-other");
  console.log(
    "GET /projects/:id",
    JSON.stringify({
      project: proj.project,
      live: proj.live.map((s) => s.session_id),
      totals: proj.totals,
      branches: proj.branches,
    }),
  );
  console.log(
    "GET /sessions/h-wt",
    JSON.stringify({
      project_id: wt.project_id,
      project_name: wt.project_name,
      phase: wt.phase,
      phase_source: wt.phase_source,
    }),
  );
  check(
    "manual phase survived restart",
    wt.phase === "Phase 5 - Atlas" && wt.phase_source === "manual",
    JSON.stringify(wt.phase),
  );
  check(
    "project view lists both repo sessions",
    ["h-main", "h-wt"].every((id) => proj.live.some((s) => s.session_id === id)),
  );
  check(
    "project view excludes the other repo",
    !proj.live.some((s) => s.session_id === "h-other") && other.project_id !== pid,
  );
  check("project name is the repo", proj.project.name === "demoapp", proj.project.name);

  const q = async (text) => get(`/search?q=${encodeURIComponent(text)}`);
  const z = await q("zebra");
  console.log(`GET /search?q=zebra -> ${z.results.length} results, took_ms=${z.took_ms}`);
  check(
    "search by prompt text finds the sessions after restart",
    z.results.length >= 3 && z.results.every((r) => r.kind === "session"),
  );
  const a = await q("atlas");
  console.log(
    `GET /search?q=atlas -> ${JSON.stringify(a.results.map((r) => [r.kind, r.id]))}, took_ms=${a.took_ms}`,
  );
  check(
    "search finds the phase and its session",
    a.results.some((r) => r.kind === "phase" && r.id === "Phase 5 - Atlas") &&
      a.results.some((r) => r.id === "h-wt"),
  );
  const d = await q("demo");
  check(
    "search finds the project by prefix",
    d.results.some((r) => r.kind === "project" && r.id === pid),
  );
  const hostile = await fetch(`${base}/search?q=${encodeURIComponent('NEAR(" title:x* (')}`, {
    headers: auth,
  });
  check("hostile query is a 200", hostile.status === 200, String(hostile.status));
  check("search needs the token", (await fetch(`${base}/search?q=a`)).status === 401);
}

try {
  await main();
} catch (err) {
  console.log("ERROR", err instanceof Error ? err.message : err);
  failures.push("error");
} finally {
  await stop();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(bundle, { force: true });
}
console.log(failures.length === 0 ? "HARNESS PASS" : `HARNESS FAIL (${failures.join(", ")})`);
process.exit(failures.length === 0 ? 0 : 1);
