// Daemon end-to-end harness (R1.4, R1.5, R1.6, R1.7 integration). Starts the BUILT daemon
// (dist/daemon.mjs) against a stub hub, a temp probe home and a temp Claude config dir (never the
// real ~/.claude), feeds it hook spool lines for one session plus transcript lines, kills the
// session's process without a SessionEnd, and checks what the hub received. Then kills the daemon,
// restarts it and checks nothing is delivered again. Prints one evidence line per assertion and a
// final `RESULT pass|fail`. Needs `pnpm -F @sessiondeck/probe build` first (the test does it).
//   node scripts/harness-daemon-e2e.mjs
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StubHub, killTree, makeUlid, spawnDaemon } from "./loss-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "..", "contract", "fixtures");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = (dir, name) => JSON.parse(readFileSync(join(fixtures, dir, name), "utf8"));

async function until(cond, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

const SID = "e2e00000-0000-4000-8000-000000000001";
const OUT_SID = "e2e00000-0000-4000-8000-0000000000ff"; // a session whose transcript is outside projects
const AGENT = "750bc48c804160940"; // the SubagentStart fixture's agent_id
const HOST = "loss-host"; // makeHome's host

/** Returns { checks: [{name, ok, detail}], pass }. `log` receives each evidence line as it happens. */
export async function runDaemonE2E({ log = () => undefined } = {}) {
  const { appendSpoolLines } = await import(
    pathToFileURL(join(root, "dist", "spool-writer.mjs")).href
  );
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const hub = new StubHub();
  await hub.start();
  const home = mkdtempSync(join(tmpdir(), "sd-e2e-home-"));
  const claudeDir = mkdtempSync(join(tmpdir(), "sd-e2e-claude-"));
  writeFileSync(
    join(home, "probe.json"),
    JSON.stringify({ hubUrl: hub.url, token: hub.token, host: HOST }),
  );
  const projDir = join(claudeDir, "projects", "e2e-project");
  const mainPath = join(projDir, `${SID}.jsonl`);
  const subPath = join(projDir, SID, "subagents", `agent-${AGENT}.jsonl`);
  mkdirSync(join(projDir, SID, "subagents"), { recursive: true });
  const env = {
    CLAUDE_CONFIG_DIR: claudeDir,
    SESSIONDECK_BACKOFF_CAP_MS: "1500",
    SESSIONDECK_HEARTBEAT_MS: "700",
  };

  const mainLines = [];
  const subLines = [];
  let counter = 0;
  const addLines = (file, bucket, n, tag) => {
    const ls = Array.from({ length: n }, () =>
      JSON.stringify({ n: counter++, tag, pad: "y".repeat(30) }),
    );
    appendFileSync(file, ls.map((l) => `${l}\n`).join(""));
    bucket.push(...ls);
  };
  const env1 = (kind, fields) => {
    const ts = Date.now();
    return {
      v: 1,
      id: makeUlid(ts, counter++),
      kind,
      host: HOST,
      os: process.platform === "win32" ? "win32" : "linux",
      ts,
      ...fields,
    };
  };

  // The stand-in for the Claude process. Spawned before the envelopes so it is not younger than them.
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  let daemon;
  try {
    // A few transcript lines exist before the session starts (the tailer must take them from byte 0).
    addLines(mainPath, mainLines, 3, "main");
    daemon = spawnDaemon(home, env);
    await sleep(500);

    const start = {
      ...fixture("SessionStart", "01-startup.json"),
      session_id: SID,
      transcript_path: mainPath,
    };
    const subStart = {
      ...fixture("SubagentStart", "01-subagent.json"),
      session_id: SID,
      transcript_path: mainPath,
    };
    const hookIds = [];
    const hookLine = (payload, sid = SID) => {
      const l = env1("hook", {
        session_id: sid,
        hook_event_name: payload.hook_event_name,
        ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
        payload,
      });
      hookIds.push(l.id);
      return l;
    };
    const spool = join(home, "spool");
    // The hook writes the hook line and, for SessionStart, a liveness line carrying the pid.
    appendSpoolLines(spool, [
      hookLine(start),
      env1("liveness", { session_id: SID, payload: { pid: child.pid, alive: true } }),
    ]);
    await sleep(300);
    addLines(mainPath, mainLines, 4, "main");
    appendSpoolLines(spool, [hookLine(subStart)]);
    // D-S2-10: a SessionStart whose transcript_path is outside <config>/projects must be refused.
    const secretPath = join(claudeDir, "outside", "secret.jsonl");
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, `${JSON.stringify({ secret: "SECRETMARK-do-not-ship" })}\n`);
    const outStart = {
      ...fixture("SessionStart", "01-startup.json"),
      session_id: OUT_SID,
      transcript_path: secretPath,
    };
    const outHook = hookLine(outStart, OUT_SID);
    appendSpoolLines(spool, [outHook]);
    await sleep(700);
    addLines(subPath, subLines, 5, "sub");
    await sleep(400);
    addLines(mainPath, mainLines, 2, "main");
    addLines(subPath, subLines, 2, "sub");

    const transcriptOf = (agent) => {
      const byLine = new Map();
      let deliveries = 0;
      for (const a of hub.accepted.values()) {
        if (a.kind !== "transcript" || a.agent_id !== agent) continue;
        a.payload.lines.forEach((l, i) => {
          deliveries += 1;
          byLine.set(a.payload.start_line + i, [
            ...(byLine.get(a.payload.start_line + i) ?? []),
            l,
          ]);
        });
      }
      return { byLine, deliveries };
    };
    const delivered = () =>
      transcriptOf(undefined).deliveries >= mainLines.length &&
      transcriptOf(AGENT).deliveries >= subLines.length;
    await until(delivered, 15_000);
    await until(() => hookIds.every((id) => hub.accepted.has(id)), 15_000);

    // Hook envelopes.
    const stored = hookIds.map((id) => hub.accepted.get(id));
    const allSeqs = [...hub.accepted.values()].map((a) => a.seq).sort((a, b) => a - b);
    const contiguous = allSeqs.every((s, i) => s === i);
    const hookSeqs = stored.map((a) => a?.seq);
    check(
      "hook envelopes",
      stored.every(Boolean) && hookSeqs.every((s, i) => i === 0 || s > hookSeqs[i - 1]),
      `${stored.filter(Boolean).length}/${hookIds.length} received in order, seq ${hookSeqs.join(",")}`,
    );
    check(
      "seq contiguous, no duplicate ids",
      contiguous && hub.conflicts === 0 && hub.resentIds === 0,
      `${allSeqs.length} envelopes, seq 0..${allSeqs.length - 1}, conflicts=${hub.conflicts}, resent_ids=${hub.resentIds}`,
    );

    // Transcript lines, exactly once.
    for (const [label, agent, expected] of [
      ["main", undefined, mainLines],
      ["subagent", AGENT, subLines],
    ]) {
      const { byLine } = transcriptOf(agent);
      const got = [...byLine.keys()].sort((a, b) => a - b).map((k) => byLine.get(k));
      const once = got.every((v) => v.length === 1);
      const same = JSON.stringify(got.map((v) => v[0])) === JSON.stringify(expected);
      check(
        `transcript ${label} lines exactly once`,
        once && same,
        `expected=${expected.length} got=${got.length} unique_deliveries=${once} identical=${same}`,
      );
    }

    await until(() => hub.accepted.has(outHook.id), 15_000);
    await sleep(1500); // several tail polls
    const leaked = [...hub.accepted.values()].filter(
      (a) =>
        (a.kind === "transcript" && a.session_id === OUT_SID) ||
        (JSON.stringify(a.payload).includes("SECRETMARK") && a.kind === "transcript"),
    );
    check(
      "SessionStart with transcript_path outside projects is refused",
      hub.accepted.has(outHook.id) && leaked.length === 0,
      `hook_forwarded=${hub.accepted.has(outHook.id)} transcript_envelopes_from_outside=${leaked.length}`,
    );

    // Liveness: wait out the probation (a node child is not named claude), kill without SessionEnd.
    const livenessFile = join(home, "daemon", "liveness.json");
    const confirmed = await until(() => {
      try {
        const e = JSON.parse(readFileSync(livenessFile, "utf8")).sessions[SID];
        return e && e.state === "tracking" && e.probation !== true;
      } catch {
        return false;
      }
    }, 30_000);
    check(
      "liveness tracking confirmed",
      confirmed,
      `pid=${child.pid} registered and past probation`,
    );
    const killedAt = Date.now();
    child.kill("SIGKILL");
    const isDeath = (a) =>
      a.kind === "liveness" && a.session_id === SID && a.payload.alive === false;
    const died = await until(() => [...hub.accepted.values()].some(isDeath), 20_000);
    const ms = Date.now() - killedAt;
    const death = [...hub.accepted.values()].find(isDeath);
    check(
      "liveness alive:false within 15 s of the kill",
      died && ms <= 15_000 && death.payload.pid === child.pid,
      `detected_ms=${died ? ms : "never"} pid=${death?.payload.pid}`,
    );
    const heartbeats = [...hub.accepted.values()].filter(
      (a) => a.kind === "probe" && a.payload?.type === "heartbeat",
    ).length;
    check("host heartbeat received", heartbeats >= 1, `heartbeats=${heartbeats}`);

    // Restart: nothing may be delivered again.
    await sleep(1500);
    const nonHeartbeat = () =>
      [...hub.accepted.entries()].filter(
        ([, a]) => !(a.kind === "probe" && a.payload?.type === "heartbeat"),
      );
    const before = nonHeartbeat().length;
    const resentBefore = hub.resentIds;
    await killTree(daemon);
    daemon = spawnDaemon(home, env);
    await sleep(13_000); // a liveness tick plus grace, several heartbeats, several tail polls
    const after = nonHeartbeat().length;
    check(
      "no redelivery after daemon kill and restart",
      after === before && hub.resentIds === resentBefore && hub.conflicts === 0,
      `non_heartbeat_before=${before} after=${after} resent_ids=${hub.resentIds - resentBefore} conflicts=${hub.conflicts}`,
    );
    // A line appended after the restart still arrives, once.
    addLines(mainPath, mainLines, 1, "after-restart");
    await until(() => transcriptOf(undefined).deliveries >= mainLines.length, 10_000);
    const { byLine } = transcriptOf(undefined);
    check(
      "daemon resumes tailing after restart",
      byLine.size === mainLines.length && [...byLine.values()].every((v) => v.length === 1),
      `main_lines=${byLine.size}/${mainLines.length}`,
    );
    // Contiguity and duplicates over everything accepted, restart included.
    const finalSeqs = [...hub.accepted.values()].map((a) => a.seq).sort((a, b) => a - b);
    const finalLeak = [...hub.accepted.values()].some(
      (a) => a.kind === "transcript" && a.session_id === OUT_SID,
    );
    check(
      "seq contiguous, no duplicates, nothing from outside projects (whole run)",
      finalSeqs.every((x, i) => x === i) && hub.conflicts === 0 && !finalLeak,
      `${finalSeqs.length} envelopes, seq 0..${finalSeqs.length - 1}, conflicts=${hub.conflicts}, resent_ids=${hub.resentIds}, leaked=${finalLeak}`,
    );
  } finally {
    if (checks.some((c) => !c.ok)) {
      try {
        const lines = readFileSync(join(home, "daemon", "daemon.log"), "utf8")
          .trim()
          .split("\n");
        for (const l of lines.slice(-15)) log(`  daemon.log: ${l}`);
      } catch {
        log("  daemon.log: unreadable");
      }
    }
    child.kill("SIGKILL");
    await killTree(daemon);
    await hub.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  }
  return { checks, pass: checks.length > 0 && checks.every((c) => c.ok) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = await runDaemonE2E({ log: (l) => console.log(l) });
  console.log(`RESULT ${r.pass ? "pass" : "fail"}`);
  process.exit(r.pass ? 0 : 1);
}
