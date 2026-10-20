// WS fan-out harness (R2.5). 5 clients on /stream; N ingest batches synthesized from contract
// fixtures with fresh ids; every delta must reach every client exactly once, max latency < 100 ms
// from the ingest HTTP response; then one client reconnects and must resync without duplicates.
//
//   HUB_URL=http://host:8787 HUB_TOKEN=... node scripts/ws-harness.mjs [N]
//   node scripts/ws-harness.mjs            (no HUB_URL: starts an in-process hub on a temp DB)
//
// Exit code 0 on PASS, 1 on FAIL.
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = path.resolve(root, "../contract/fixtures");
const N = Number(process.argv[2] ?? process.env.HUB_HARNESS_N ?? 200);
const CLIENTS = 5;
const SESSIONS = 20;
const LIMIT_MS = 100;
const TIMEOUT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const freshId = () => {
  const b = randomBytes(26);
  let s = "0"; // ULID timestamp part must stay below 2^48
  for (let i = 0; i < 25; i++) s += B32[b[i] % 32];
  return s;
};
const fixture = (rel) => JSON.parse(readFileSync(path.join(FIXTURES, rel), "utf8"));
const START = fixture("SessionStart/01-startup.json");
const PROMPT = fixture("UserPromptSubmit/01-sample.json");

// ---------- hub under test ----------
let url = process.env.HUB_URL;
let token = process.env.HUB_TOKEN;
let stopHub = async () => {};
if (!url) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hub-harness-"));
  const out = path.join(root, "dist", "harness-hub.mjs");
  await build({
    stdin: {
      contents:
        'export { buildServer } from "./src/server.ts"; export { loadConfig } from "./src/config.ts"; export { Store } from "./src/db/store.ts";',
      resolveDir: root,
      sourcefile: "harness-entry.ts",
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
  const { buildServer, loadConfig, Store } = await import(pathToFileURL(out).href);
  token = randomBytes(24).toString("hex");
  const store = Store.open(path.join(tmp, "hub.sqlite"));
  store.migrate();
  const app = buildServer({ config: loadConfig({ HUB_TOKEN: token }), store });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${app.server.address().port}`;
  stopHub = async () => {
    await app.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  };
}
if (!token) throw new Error("HUB_TOKEN is required with HUB_URL");
const wsUrl = `${url.replace(/^http/, "ws")}/stream`;

// ---------- clients ----------
const RUN = randomBytes(4).toString("hex");
const HOST = `harness-${RUN}`;
const sid = (i) => `harness-${RUN}-s${i}`;
const mine = (id) => id.startsWith(`harness-${RUN}-`);

/** key = session_id@last_event_at; value = receive times (performance.now) */
function connect(label) {
  const c = { label, initial: null, deltas: new Map(), ws: null };
  c.ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  c.ws.on("message", (d) => {
    const t = performance.now();
    const m = JSON.parse(String(d));
    if (m.type === "initial") c.initial = m.sessions;
    else if (m.type === "session" && mine(m.data.session_id)) {
      const k = `${m.data.session_id}@${m.data.last_event_at}`;
      const a = c.deltas.get(k) ?? [];
      a.push(t);
      c.deltas.set(k, a);
    }
  });
  return new Promise((resolve, reject) => {
    c.ws.once("error", reject);
    c.ws.once("unexpected-response", (_q, r) =>
      reject(new Error(`upgrade refused: ${r.statusCode}`)),
    );
    c.ws.once("open", async () => {
      const end = Date.now() + TIMEOUT_MS;
      while (c.initial === null && Date.now() < end) await sleep(2);
      if (c.initial === null) reject(new Error(`${label}: no initial`));
      else resolve(c);
    });
  });
}

// ---------- ingest ----------
let seq = 0;
let ts = Date.now() - 1_000_000;
const latest = new Map(); // session -> last_event_at
async function ingest(i) {
  const session = sid(i % SESSIONS);
  const first = !latest.has(session);
  ts += 6000; // beyond the 5 s signature window
  const env = {
    v: 1,
    id: freshId(),
    kind: "hook",
    host: HOST,
    os: "linux",
    session_id: session,
    hook_event_name: first ? "SessionStart" : "UserPromptSubmit",
    ts,
    seq: seq++,
    payload: {
      ...(first ? START : PROMPT),
      session_id: session,
      prompt: `p${seq}`,
      cwd: "/harness",
    },
  };
  const t0 = performance.now();
  const res = await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ host: HOST, envelopes: [env] }),
  });
  const tResp = performance.now();
  if (res.status !== 200) throw new Error(`ingest ${res.status} ${await res.text()}`);
  latest.set(session, ts);
  return { key: `${session}@${ts}`, t0, tResp };
}

async function waitAll(clients, key) {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    if (clients.every((c) => c.deltas.has(key))) return true;
    await sleep(1);
  }
  return false;
}

const pct = (a, p) =>
  a.length === 0 ? 0 : a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const f = (n) => n.toFixed(2);

// ---------- run ----------
let failed = false;
const notes = [];
try {
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) clients.push(await connect(`c${i}`));

  const lat = []; // response -> receipt, per delta per client (clamped at 0)
  const e2e = []; // request start -> receipt
  let missing = 0;
  const expected = [];
  for (let i = 0; i < N; i++) {
    const r = await ingest(i);
    expected.push(r.key);
    if (!(await waitAll(clients, r.key)))
      missing += clients.filter((c) => !c.deltas.has(r.key)).length;
    for (const c of clients) {
      const t = c.deltas.get(r.key)?.[0];
      if (t !== undefined) {
        lat.push(Math.max(0, t - r.tResp));
        e2e.push(t - r.t0);
      }
    }
  }
  await sleep(100); // let any duplicate arrive
  let dup = 0;
  for (const c of clients) for (const a of c.deltas.values()) dup += a.length - 1;
  const strays = clients.reduce(
    (n, c) => n + [...c.deltas.keys()].filter((k) => !expected.includes(k)).length,
    0,
  );
  lat.sort((a, b) => a - b);
  e2e.sort((a, b) => a - b);
  const main = {
    deltas: N,
    clients: CLIENTS,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    max: lat.at(-1) ?? 0,
    dup,
    missing,
    e2eMax: e2e.at(-1) ?? 0,
  };
  const mainOk = main.dup === 0 && main.missing === 0 && strays === 0 && main.max < LIMIT_MS;

  // ---- reconnect ----
  const victim = clients[0];
  victim.ws.close();
  await sleep(50);
  const K = 20;
  for (let i = 0; i < K; i++) await ingest(N + i);
  const back = await connect("c0-reconnected");
  clients[0] = back;
  const byId = new Map(
    back.initial.filter((s) => mine(s.session_id)).map((s) => [s.session_id, s.last_event_at]),
  );
  let stale = 0;
  for (const [session, at] of latest) if (byId.get(session) !== at) stale++;
  const M = 20;
  const newKeys = [];
  for (let i = 0; i < M; i++) {
    const r = await ingest(N + K + i);
    newKeys.push(r.key);
    await waitAll(clients, r.key);
  }
  await sleep(100);
  const backKeys = [...back.deltas.keys()];
  const replayed = backKeys.filter((k) => !newKeys.includes(k)).length;
  const reDup = [...back.deltas.values()].reduce((n, a) => n + a.length - 1, 0);
  const reMissing = newKeys.filter((k) => !back.deltas.has(k)).length;
  const reOk = stale === 0 && replayed === 0 && reDup === 0 && reMissing === 0;

  const row = (name, d, c, p50, p95, max, dupN, miss, ok) =>
    `${name.padEnd(12)} ${String(d).padStart(7)} ${String(c).padStart(7)} ${p50.padStart(8)} ${p95.padStart(8)} ${max.padStart(8)} ${String(dupN).padStart(4)} ${String(miss).padStart(8)}  ${ok ? "PASS" : "FAIL"}`;
  console.log(
    `hub: ${process.env.HUB_URL ? "remote" : "in-process"}  sessions=${SESSIONS}  limit=${LIMIT_MS} ms (ingest response -> receipt)`,
  );
  console.log(
    `${"phase".padEnd(12)} ${"deltas".padStart(7)} ${"clients".padStart(7)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"max ms".padStart(8)} ${"dup".padStart(4)} ${"missing".padStart(8)}  result`,
  );
  console.log(
    row(
      "fan-out",
      main.deltas,
      main.clients,
      f(main.p50),
      f(main.p95),
      f(main.max),
      main.dup,
      main.missing,
      mainOk,
    ),
  );
  console.log(row("reconnect", M, 1, "-", "-", "-", reDup + replayed, reMissing + stale, reOk));
  console.log(
    `(fan-out from request start: p50 ${f(pct(e2e, 50))} p95 ${f(pct(e2e, 95))} max ${f(main.e2eMax)} ms; deltas that arrived before the HTTP response was read count as 0 ms; stray deltas: ${strays}; stale sessions in new initial: ${stale}; replayed old deltas: ${replayed})`,
  );
  failed = !(mainOk && reOk);
  for (const c of clients) c.ws.terminate();
} catch (err) {
  failed = true;
  notes.push(String(err?.message ?? err));
}
await stopHub();
for (const n of notes) console.error(`FAIL: ${n}`);
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
