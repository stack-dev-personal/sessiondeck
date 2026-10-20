// Liveness harness (R1.7). Real child processes stand in for claude; the real LivenessMonitor (real
// process.kill probe, real process lookup, real outbox, real state file, default 10 s tick) watches
// them. Prints evidence lines; exit 1 on any failure. Takes about 40 s.
//   node scripts/harness-liveness.mjs        (Node 22.18+ runs the .ts sources directly)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivenessMonitor } from "../src/daemon/liveness.ts";
import { createOutbox } from "../src/daemon/outbox.ts";
import { buildEnvelope } from "../src/envelope.ts";

const home = mkdtempSync(join(tmpdir(), "sd-harness-liveness-"));
const outDir = join(home, "daemon", "outbox");
const statePath = join(home, "daemon", "liveness.json");
const sessionsDir = join(home, "no-claude-sessions"); // never the real ~/.claude
const outbox = createOutbox(outDir);
const env = (sid, pid, ts = Date.now()) => ({
  ...buildEnvelope({
    kind: "liveness",
    host: "harness",
    payload: { pid, alive: true },
    session_id: sid,
    ts,
  }),
  seq: 0,
});
const hook = (sid, name) => ({
  ...buildEnvelope({
    kind: "hook",
    host: "harness",
    payload: { session_id: sid },
    session_id: sid,
    hook_event_name: name,
  }),
  seq: 0,
});
const child = () =>
  spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
const mkMonitor = () =>
  new LivenessMonitor({
    statePath,
    enqueue: outbox,
    host: "harness",
    sessionsDir,
    log: (l, m) => console.log(`  [${l}] ${m}`),
  });
const deaths = () => {
  const out = [];
  if (!existsSync(outDir)) return out;
  for (const f of readdirSync(outDir))
    for (const raw of readFileSync(join(outDir, f), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(raw);
      if (e.kind === "liveness" && e.payload.alive === false) out.push(e);
    }
  return out;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (c) => new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r)));

const A = child(); // dies with no SessionEnd
const B = child(); // SessionEnd first, then dies
const C = child(); // /clear: two session ids on one pid, then dies
const SA = "harness-a",
  SB = "harness-b",
  SC1 = "harness-c1",
  SC2 = "harness-c2";
let m = mkMonitor();
await m.start();
m.onSpoolLine(env(SA, A.pid));
m.onSpoolLine(env(SB, B.pid));
m.onSpoolLine(env(SC1, C.pid, Date.now() - 1000));
m.onSpoolLine(env(SC2, C.pid));
await sleep(500);
m.onSpoolLine(hook(SB, "SessionEnd"));
await sleep(500);

// node children are not named "claude": each is on probation until the first tick finds it alive.
for (
  let i = 0;
  i < 150 && m.snapshot().some((e) => e.state === "tracking" && e.probation === true);
  i += 1
)
  await sleep(100);
console.log(
  `R1.7 probation_cleared=${m.snapshot().every((e) => e.state !== "tracking" || e.probation !== true)}`,
);

const killedAt = Date.now();
for (const c of [A, B, C]) c.kill("SIGKILL");
await Promise.all([A, B, C].map(exited));
let detected;
while (Date.now() - killedAt < 25_000) {
  if (deaths().some((d) => d.session_id === SA)) {
    detected = Date.now() - killedAt;
    break;
  }
  await sleep(100);
}
const ok15 = detected !== undefined && detected <= 15_000;
console.log(
  `R1.7 killed_pid=${A.pid} detected_ms=${detected ?? "never"} envelope=alive:false within_15s=${ok15}`,
);
await sleep(3000); // let C's death land too
const d = deaths();
const ids = d.map((x) => x.session_id).sort();
const pidOk = d.find((x) => x.session_id === SA)?.payload.pid === A.pid;
console.log(`R1.7 payload_pid_matches=${pidOk} deaths=${ids.join(",")}`);
console.log(
  `R1.7 sessionend_suppressed=${!ids.includes(SB)} same_pid_old_session_silent=${!ids.includes(SC1)} same_pid_new_session_reported=${ids.includes(SC2)}`,
);
await m.stop();
m = mkMonitor(); // restart: the state file must prevent repeats
await m.start();
await sleep(13_000); // one more full tick plus grace
const after = deaths().length;
console.log(
  `R1.7 restart deaths_before=${d.length} deaths_after=${after} no_duplicate_after_restart=${after === d.length}`,
);
await m.stop();
rmSync(home, { recursive: true, force: true });
const pass = ok15 && pidOk && ids.join(",") === [SA, SC2].sort().join(",") && after === d.length;
console.log(pass ? "RESULT pass" : "RESULT FAIL");
process.exit(pass ? 0 : 1);
