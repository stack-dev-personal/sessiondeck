// Live-shape harness for R2.12 / R2.13. Replays the recorded headless session (fixture
// transcripts/01-subagents plus hook fixtures, no statusline) against a hub of its own and prints
// the figures the hub derived. Exit 0 only if every required figure is non-null.
//
//   node scripts/headless-harness.mjs
//
// Hub: `docker compose -p sd-2-s8d` (hub service only) on 127.0.0.1:28787 with a temp env file and
// a random token. If the image build or start fails, a local node hub on 127.0.0.1:28787 with a
// temp database runs instead. Never touches port 8787 or the project `sessiondeck`. Tears down on
// every exit path. Pass C:/... style paths to node on Windows.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = path.resolve(root, "../..");
const FIXTURES = path.resolve(root, "../contract/fixtures");
const PROJECT = "sd-2-s8d";
const CONTAINER = "sd-2-S8d-hub";
const PORT = 28787;
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = "harness-laptop";
const CHUNK = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), "sd-2-s8d-harness-"));
const token = randomBytes(24).toString("hex");
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let mode = "none";
let localProc;

function compose(args, opts = {}) {
  const files = ["-f", path.join(repo, "infra/docker-compose.yml"), "-f", path.join(tmp, "override.yml")];
  return spawnSync("docker", ["compose", "-p", PROJECT, ...files, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HUB_ENV_FILE: path.join(tmp, "hub.env"),
      SD_HUB_PUBLISH_PORT: String(PORT),
      SD_HUB_PUBLISH_IP: "127.0.0.1",
    },
    ...opts,
  });
}

async function teardown() {
  if (mode === "docker" || mode === "docker-starting") {
    const r = compose(["down", "-v", "--remove-orphans"]);
    if (r.status !== 0) console.error("compose down failed:", (r.stderr ?? "").slice(-300));
  }
  if (localProc && !localProc.killed) localProc.kill();
  await sleep(200);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    console.error("temp dir removal failed:", e.message);
  }
}

async function waitHealthy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function startDocker() {
  writeFileSync(path.join(tmp, "hub.env"), `HUB_TOKEN=${token}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(tmp, "override.yml"),
    `services:\n  hub:\n    container_name: ${CONTAINER}\n    image: sd-2-s8d-hub:dev\n    restart: "no"\n`,
  );
  mode = "docker-starting";
  const up = compose(["up", "-d", "--build", "hub"], { stdio: ["ignore", "pipe", "pipe"] });
  if (up.status !== 0) {
    console.error("docker up failed:", (up.stderr ?? "").slice(-400));
    return false;
  }
  mode = "docker";
  return waitHealthy(60_000);
}

async function startLocal() {
  if (mode !== "none") {
    const r = compose(["down", "-v", "--remove-orphans"]);
    if (r.status !== 0) console.error("compose down failed:", (r.stderr ?? "").slice(-300));
  }
  const bundle = path.join(root, "scripts/bundle.mjs");
  const out = path.join(root, "dist/harness-main.mjs");
  const b = spawnSync(process.execPath, [bundle, "src/main.ts", "dist/harness-main.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  if (b.status !== 0) throw new Error(`bundle failed: ${b.stderr}`);
  mode = "local";
  localProc = spawn(process.execPath, [out], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HUB_TOKEN: token,
      HUB_BIND: "127.0.0.1",
      HUB_PORT: String(PORT),
      HUB_DB_PATH: path.join(tmp, "hub.sqlite"),
    },
  });
  return waitHealthy(30_000);
}

// ---------- envelopes, shaped like the probe daemon ships them ----------
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let idN = 0;
const ulid = () => {
  let v = Date.now() * 1000 + ++idN;
  let s = "";
  for (let i = 0; i < 25; i++) {
    s = B32[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return `0${s}`;
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const lines = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l !== "");

function buildEnvelopes(dir) {
  const tdir = path.join(dir, "transcripts/01-subagents");
  const main = lines(path.join(tdir, "session.jsonl"));
  const session = JSON.parse(main.find((l) => l.includes('"sessionId"'))).sessionId;
  const files = readdirSync(path.join(tdir, "subagents")).filter((f) => f.endsWith(".jsonl"));
  const subs = files.map((f) => {
    const id = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const meta = readJson(path.join(tdir, "subagents", f.replace(/\.jsonl$/, ".meta.json")));
    return { id, type: meta.agentType || "general-purpose", lines: lines(path.join(tdir, "subagents", f)) };
  });
  const out = [];
  let seq = 0;
  const push = (kind, payload, extra = {}) =>
    out.push({
      v: 1, id: ulid(), kind, host: HOST, os: "linux", session_id: session,
      ts: Date.now(), seq: seq++, payload, ...extra,
    });
  const hook = (rel, over = {}) => {
    const p = { ...readJson(path.join(dir, rel)), session_id: session, ...over };
    push("hook", p, { hook_event_name: p.hook_event_name });
  };
  const transcript = (all, agent) => {
    for (let i = 0; i < all.length; i += CHUNK) {
      push("transcript", { start_line: i, lines: all.slice(i, i + CHUNK) },
        agent === undefined ? {} : { agent_id: agent });
    }
  };
  hook("SessionStart/01-startup.json");
  hook("UserPromptSubmit/01-sample.json");
  for (const s of subs) hook("SubagentStart/01-subagent.json", { agent_id: s.id, agent_type: s.type });
  transcript(main);
  for (const s of subs) transcript(s.lines, s.id);
  for (const s of subs) hook("SubagentStop/01-subagent.json", { agent_id: s.id, agent_type: s.type });
  hook("Stop/01-after-ask.json");
  return { session, envelopes: out, subs };
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}`);
  return res.json();
}

async function run() {
  const fixtureDir = path.join(tmp, "fixtures");
  for (const d of ["transcripts/01-subagents", "SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"]) {
    cpSync(path.join(FIXTURES, d), path.join(fixtureDir, d), { recursive: true });
  }
  const { session, envelopes, subs } = buildEnvelopes(fixtureDir);

  let up = false;
  try {
    up = await startDocker();
  } catch (e) {
    console.error("docker path error:", e.message);
  }
  if (!up) {
    console.log("docker path unavailable; falling back to a local node hub");
    up = await startLocal();
  }
  if (!up) throw new Error("hub did not become healthy");
  console.log(`hub path: ${mode === "docker" ? `docker compose -p ${PROJECT} (container ${CONTAINER})` : "local node process"} on ${BASE}`);

  for (let i = 0; i < envelopes.length; i += 100) {
    const r = await api("POST", "/ingest", { host: HOST, envelopes: envelopes.slice(i, i + 100) });
    if (r.rejected?.length) throw new Error(`rejected envelopes: ${JSON.stringify(r.rejected).slice(0, 300)}`);
  }
  console.log(`posted ${envelopes.length} envelopes for session ${session}`);

  // The cost fill is asynchronous (debounced 1 s): poll until cost.usd appears.
  let snap;
  for (let i = 0; i < 40; i++) {
    snap = await api("GET", `/sessions/${session}`);
    if (snap.cost?.usd != null) break;
    await sleep(500);
  }
  const cost = await api("GET", `/sessions/${session}/cost`);
  return { snap, cost, subs };
}

function report({ snap, cost }) {
  const missing = [];
  const need = (name, v) => {
    if (v === null || v === undefined || v === "") missing.push(name);
  };
  need("model", snap.model?.id);
  need("context tokens", snap.context?.input);
  need("cost.usd", snap.cost?.usd);
  need("cost route cost_usd", cost.cost_usd);
  need("git.branch", snap.git?.branch);
  need("last message", snap.last_assistant_message);
  // window and used_pct are expected null (R2.12: show tokens without a percent when unknown).
  const msg = (snap.last_assistant_message ?? "").replace(/\s+/g, " ").slice(0, 80);
  console.log("\nsession");
  console.table([{
    model: snap.model?.id ?? null,
    ctx_tokens: snap.context?.input ?? null,
    window: snap.context?.window ?? null,
    used_pct: snap.context?.used_pct ?? null,
    "cost.usd": snap.cost?.usd ?? null,
    route_cost_usd: cost.cost_usd ?? null,
    branch: snap.git?.branch ?? null,
    last_message: msg,
  }]);
  console.log("sources:", JSON.stringify(snap.sources ?? {}));
  console.log("\nsubagents");
  console.table(snap.subagents.map((s) => ({
    agent_id: s.agent_id, agent_type: s.agent_type, model: s.model, tokens: s.tokens,
    context_window: s.context_window, figures_source: s.figures_source ?? null,
  })));
  if (snap.subagents.length === 0) missing.push("subagents (none)");
  for (const s of snap.subagents) {
    need(`subagent ${s.agent_id} model`, s.model);
    need(`subagent ${s.agent_id} tokens`, s.tokens);
    need(`subagent ${s.agent_id} figures_source`, s.figures_source);
  }
  if (missing.length > 0) {
    console.error(`FAIL: null required figures: ${missing.join(", ")}`);
    return 1;
  }
  console.log("PASS: all required figures present");
  return 0;
}

let code = 1;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void teardown().finally(() => process.exit(130)));
}
try {
  code = report(await run());
} catch (e) {
  console.error("harness error:", e.message);
} finally {
  await teardown();
}
process.exit(code);
