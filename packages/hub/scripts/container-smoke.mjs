// Container smoke harness (R2.8, R2.5 against the container). Builds the hub image, runs it on a
// docker network with a named volume, and prints evidence. Exit 0 only if every check passes.
//
//   pnpm -F @sessiondeck/hub container:smoke
//
// Safety: every docker object it creates is named with PREFIX (default sd-1-S3-), it never
// inspects or touches any other container, and the container and volume are removed in `finally`.
// The token is random per run, passed through the environment (never argv) and never printed.
//
// Env overrides: SMOKE_PREFIX (default sd-1-S3-), SMOKE_NETWORK (default sprint-1_default),
// SMOKE_IMAGE (default sd-1-s3-hub:dev), SMOKE_SKIP_ARM64=1 to skip the arm64 build attempt.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = path.resolve(root, "../..");
const PREFIX = process.env.SMOKE_PREFIX ?? "sd-1-S3-";
const NETWORK = process.env.SMOKE_NETWORK ?? "sprint-1_default";
const IMAGE = process.env.SMOKE_IMAGE ?? "sd-1-s3-hub:dev";
const NAME = `${PREFIX}hub`;
const VOLUME = `${PREFIX}hubdata`;
const URL_BASE = `http://${NAME}:8787`;
const TOKEN = randomBytes(24).toString("base64url");
const AUTH = { authorization: `Bearer ${TOKEN}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const say = (s) => console.log(s);
function check(name, ok, detail = "") {
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Never throws on removal problems; only ever touches our own names. */
function cleanup() {
  docker(["rm", "-f", NAME], { allowFail: true });
  docker(["volume", "rm", "-f", VOLUME], { allowFail: true });
}

/** Copies the files the Dockerfile needs into a scratch context (works without BuildKit). */
function stageContext() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sd-hub-ctx-"));
  const rel = [
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
  ];
  for (const r of rel) {
    const from = path.join(repo, r);
    if (!existsSync(from)) throw new Error(`missing build input ${r}`);
    mkdirSync(path.dirname(path.join(dir, r)), { recursive: true });
    cpSync(from, path.join(dir, r), { recursive: true });
  }
  return dir;
}

function http(method, urlPath, { headers = AUTH, body } = {}) {
  return fetch(`${URL_BASE}${urlPath}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function wsUpgradeStatus(headers) {
  return new Promise((resolve, reject) => {
    const req = request(`${URL_BASE}/stream`, {
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, length: res.headers["content-length"] });
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, length: undefined });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitHealthy(label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${URL_BASE}/health`);
      if (r.ok) return { ms: Date.now() - t0, body: await r.text() };
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > 60_000) {
      const logs = docker(["logs", "--tail", "20", NAME], { allowFail: true });
      throw new Error(`${label}: hub not healthy in 60 s\n${logs.out}\n${logs.err}`);
    }
    await sleep(250);
  }
}

// ---------- fixture spool: the test sequences, re-ided, shifted to end now ----------
async function loadSequences() {
  const out = path.join(root, "dist", "container-smoke-seq.mjs");
  await build({
    stdin: {
      contents: 'export { SEQUENCES } from "./test/support/sequences.ts";',
      resolveDir: root,
      sourcefile: "smoke-seq-entry.ts",
    },
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "warning",
  });
  const { SEQUENCES } = await import(`${out}?t=${Date.now()}`);
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const freshId = () => {
    const b = randomBytes(26);
    let s = "0";
    for (let i = 0; i < 25; i++) s += B32[b[i] % 32];
    return s;
  };
  const now = Date.now();
  return SEQUENCES.map((make) => {
    const seq = make();
    const last = Math.max(...seq.envelopes.map((e) => e.ts));
    const shift = now - 2000 - last;
    const envelopes = seq.envelopes.map((e) => ({ ...e, id: freshId(), ts: e.ts + shift }));
    return { name: seq.name, host: seq.host, envelopes };
  });
}

async function postAll(seqs) {
  const res = [];
  for (const s of seqs) {
    let accepted = 0;
    let sent = 0;
    for (let i = 0; i < s.envelopes.length; i += 500) {
      const chunk = s.envelopes.slice(i, i + 500);
      const r = await http("POST", "/ingest", { body: { host: s.host, envelopes: chunk } });
      if (r.status !== 200) throw new Error(`ingest ${s.name} -> ${r.status}`);
      const j = await r.json();
      accepted += j.accepted;
      sent += chunk.length;
    }
    res.push({ name: s.name, sent, accepted });
  }
  return res;
}

async function main() {
  say(`# hub container smoke  prefix=${PREFIX} network=${NETWORK} image=${IMAGE}`);
  cleanup();

  // ---------- build ----------
  const ctx = stageContext();
  try {
    const t0 = Date.now();
    const b = docker(["build", "-f", path.join(ctx, "packages/hub/Dockerfile"), "-t", IMAGE, ctx]);
    say(`# docker build ok in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    void b;
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  const size = Number(docker(["image", "inspect", "--format", "{{.Size}}", IMAGE]).out);
  const arch = docker(["image", "inspect", "--format", "{{.Architecture}}", IMAGE]).out;
  say(`image ${IMAGE}  size=${(size / 1024 / 1024).toFixed(1)} MiB  architecture=${arch}`);
  const hc = docker(["image", "inspect", "--format", "{{json .Config.Healthcheck.Test}}", IMAGE]);
  check("image declares a HEALTHCHECK", hc.out.includes("/health"), hc.out.slice(0, 60));
  const imgUser = docker(["image", "inspect", "--format", "{{.Config.User}}", IMAGE]).out;
  check("image USER is the non-root uid", imgUser.startsWith("10001"), `User=${imgUser}`);

  // ---------- run ----------
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
  const up = await waitHealthy("first start");
  say(`# healthy after ${up.ms} ms`);

  // ---------- auth and health ----------
  const h = await fetch(`${URL_BASE}/health`);
  check("GET /health 200 without token", h.status === 200, `body=${await h.text()}`);
  const r401 = await fetch(`${URL_BASE}/sessions`);
  check(
    "GET /sessions without token is 401 with content-length 0",
    r401.status === 401 && r401.headers.get("content-length") === "0" && (await r401.text()) === "",
    `status=${r401.status} content-length=${r401.headers.get("content-length")}`,
  );
  const bad = await fetch(`${URL_BASE}/sessions`, { headers: { authorization: "Bearer wrong" } });
  check("GET /sessions with a wrong token is 401", bad.status === 401, `status=${bad.status}`);
  const w401 = await wsUpgradeStatus({});
  check(
    "WS upgrade without token is 401",
    w401.status === 401,
    `status=${w401.status} content-length=${w401.length}`,
  );
  const wOk = await wsUpgradeStatus(AUTH);
  check("WS upgrade with token is 101", wOk.status === 101, `status=${wOk.status}`);

  // ---------- ingest the fixture spool ----------
  const seqs = await loadSequences();
  const first = await postAll(seqs);
  for (const r of first) say(`ingest  ${r.name.padEnd(16)} sent=${r.sent} accepted=${r.accepted}`);
  check(
    "first ingest accepted every envelope",
    first.every((r) => r.accepted === r.sent && r.sent > 0),
    `total=${first.reduce((a, r) => a + r.accepted, 0)}`,
  );

  const live = await (await http("GET", "/sessions?live=1")).json();
  say(`GET /sessions?live=1 -> ${live.length} sessions`);
  for (const s of live) say(`  ${s.session_id}  host=${s.host}  state=${s.state}`);
  check("live sessions reconstructed", live.length > 0);
  const golden = live.find((s) => s.session_id === "fef17e22-168c-4fef-8964-9af573b7f2e9");
  check("golden session present", golden !== undefined, `state=${golden?.state}`);

  // ---------- dedup ----------
  const again = await postAll(seqs);
  for (const r of again) say(`re-post ${r.name.padEnd(16)} sent=${r.sent} accepted=${r.accepted}`);
  check(
    "re-POST of the same batches accepted 0 (dedup)",
    again.every((r) => r.accepted === 0),
  );

  // ---------- restart: state lives in the volume ----------
  const before = JSON.stringify(
    (await (await http("GET", "/sessions?limit=1000")).json())
      .map((s) => [s.session_id, s.state, s.last_event_at])
      .sort(),
  );
  docker(["restart", NAME]);
  const up2 = await waitHealthy("after restart");
  say(`# healthy again after restart in ${up2.ms} ms`);
  const afterList = await (await http("GET", "/sessions?limit=1000")).json();
  const after = JSON.stringify(
    afterList.map((s) => [s.session_id, s.state, s.last_event_at]).sort(),
  );
  check("sessions persist across restart", after === before, `${afterList.length} sessions`);
  const live2 = await (await http("GET", "/sessions?live=1")).json();
  check("live view persists across restart", live2.length === live.length, `${live2.length}`);
  const re = await postAll(seqs.slice(0, 1));
  check(
    "dedup survives restart",
    re.every((r) => r.accepted === 0),
  );

  // ---------- process hygiene ----------
  const uid = docker([
    "exec",
    NAME,
    "node",
    "-e",
    "const m=require('fs').readFileSync('/proc/1/status','utf8').match(/^Uid:\\s+(\\d+)/m);console.log(m[1])",
  ]).out;
  check("PID 1 runs as uid 10001", uid === "10001", `uid=${uid}`);
  const idu = docker(["exec", NAME, "id", "-u"]).out;
  check("docker exec default user is uid 10001", idu === "10001", `id -u=${idu}`);
  const mode = docker(["exec", NAME, "stat", "-c", "%a %U", "/data/hub.sqlite"]).out;
  check("DB file mode is 0600", mode.startsWith("600 "), `stat=${mode}`);
  const dirOwner = docker(["exec", NAME, "stat", "-c", "%u", "/data"]).out;
  check("/data owned by uid 10001", dirOwner === "10001", `owner=${dirOwner}`);
  // The container's own health state (own container only); the first probe runs after the interval.
  let health = "";
  for (let i = 0; i < 60; i++) {
    health = docker(["inspect", "--format", "{{.State.Health.Status}}", NAME]).out;
    if (health === "healthy") break;
    await sleep(1000);
  }
  check("docker HEALTHCHECK reports healthy", health === "healthy", `status=${health}`);

  // ---------- WS fan-out harness against the container ----------
  say("# ws-harness against the container");
  const hr = spawnSync(process.execPath, [path.join(root, "scripts", "ws-harness.mjs")], {
    encoding: "utf8",
    env: { ...process.env, HUB_URL: URL_BASE, HUB_TOKEN: TOKEN },
    timeout: 120_000,
  });
  for (const l of (hr.stdout ?? "").trim().split("\n")) say(`  | ${l}`);
  for (const l of (hr.stderr ?? "").trim().split("\n")) if (l) say(`  | ${l}`);
  check("ws-harness PASS (R2.5 against the container)", hr.status === 0, `exit=${hr.status}`);

  // ---------- optional arm64 build ----------
  if (process.env.SMOKE_SKIP_ARM64 !== "1") arm64();
}

function arm64() {
  const bx = spawnSync("docker", ["buildx", "version"], { encoding: "utf8" });
  if (!existsSync("/proc/sys/fs/binfmt_misc/qemu-aarch64")) {
    say(
      `# arm64: buildx ${bx.status === 0 ? "available" : "NOT available"}; no qemu-aarch64 binfmt handler registered, so a linux/arm64 build cannot run here`,
    );
    say("# arm64 build skipped; see docs/HUB.md (arm64) for the static review");
    return;
  }
  const probe = `${PREFIX}arm64probe`;
  docker(["rm", "-f", probe], { allowFail: true });
  const emu = docker(
    [
      "run",
      "--rm",
      "--name",
      probe,
      "--platform",
      "linux/arm64",
      "node:22-bookworm-slim",
      "uname",
      "-m",
    ],
    { allowFail: true },
  );
  docker(["rm", "-f", probe], { allowFail: true });
  const emuOk = emu.code === 0;
  say(
    `# arm64: buildx ${bx.status === 0 ? "available" : "NOT available"}; arm64 emulation ${
      emuOk ? `works (${emu.out})` : "NOT available"
    }`,
  );
  if (!emuOk) {
    say("# arm64 build skipped (no QEMU/binfmt); see docs/HUB.md for the static review");
    return;
  }
  const tag = `${IMAGE}-arm64`;
  const ctx = stageContext();
  try {
    const t0 = Date.now();
    docker([
      "build",
      "--platform",
      "linux/arm64",
      "-f",
      path.join(ctx, "packages/hub/Dockerfile"),
      "-t",
      tag,
      ctx,
    ]);
    const a = docker(["image", "inspect", "--format", "{{.Architecture}}", tag]).out;
    check(
      "linux/arm64 build succeeds",
      a === "arm64",
      `architecture=${a} in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (e) {
  failures.push("harness error");
  say(`FAIL  harness error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  cleanup();
  say(`# removed container ${NAME} and volume ${VOLUME}`);
}
say(
  failures.length === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures.length}): ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
