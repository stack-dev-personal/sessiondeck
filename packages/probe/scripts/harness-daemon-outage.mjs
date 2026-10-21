// R1.5 at integration level: the REAL daemon, started the way a user starts it
// (`node dist/probe.mjs daemon run --home <tmp>`), forwards hook spool lines to a stub hub. The hub
// is taken down for SD_OUTAGE_MS (default 15000, a compressed stand-in; the verifier runs 600000)
// while spool lines keep arriving through the real spool writer, then restarted on the same port.
// Prints sent / accepted / duplicates / order per host / recover_ms and `RESULT pass|fail`.
//   node scripts/harness-daemon-outage.mjs           (after `pnpm -F @sessiondeck/probe build`)
//   SD_OUTAGE_MS=600000 SD_BACKOFF_CAP_MS=30000 node scripts/harness-daemon-outage.mjs
// SD_BACKOFF_CAP_MS (default 1500) shortens the daemon's 30 s retry cap so a compressed run does not
// wait out a long backoff; the real 10 minute run should leave it at 30000 (the product default).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StubHub, killTree, makeUlid } from "./loss-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = "outage-host";

async function until(cond, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

export async function runDaemonOutage({
  total = 600,
  outageMs = Number(process.env.SD_OUTAGE_MS ?? 15000),
  backoffCapMs = Number(process.env.SD_BACKOFF_CAP_MS ?? 1500),
  recoverTimeoutMs = 120_000,
} = {}) {
  const { appendSpoolLines } = await import(
    pathToFileURL(join(root, "dist", "spool-writer.mjs")).href
  );
  const hub = new StubHub();
  await hub.start();
  const home = mkdtempSync(join(tmpdir(), "sd-outage-"));
  writeFileSync(
    join(home, "probe.json"),
    JSON.stringify({ hubUrl: hub.url, token: hub.token, host: HOST }),
  );
  const claudeDir = mkdtempSync(join(tmpdir(), "sd-outage-claude-"));
  const daemon = spawn(
    process.execPath,
    [join(root, "dist", "probe.mjs"), "daemon", "run", "--home", home],
    {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeDir,
        SESSIONDECK_BACKOFF_CAP_MS: String(backoffCapMs),
        SESSIONDECK_HEARTBEAT_MS: "700",
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr.on("data", () => undefined);
  const hooks = () => [...hub.accepted.values()].filter((a) => a.kind === "hook");
  let sent = 0;
  const write = (n) => {
    const ts = Date.now();
    appendSpoolLines(join(home, "spool"), [
      {
        v: 1,
        id: makeUlid(ts, n),
        kind: "hook",
        host: HOST,
        os: process.platform === "win32" ? "win32" : "linux",
        session_id: "outage-sess",
        hook_event_name: "PostToolUse",
        ts,
        payload: { n, pad: "x".repeat(200) },
      },
    ]);
    sent += 1;
  };
  try {
    for (let n = 0; n < 50; n++) write(n);
    await until(() => hooks().length >= 50, 30_000);
    const before = hooks().length;
    await hub.stop();
    const t0 = Date.now();
    // Lines keep arriving for the whole outage, spread evenly (about one every 100 ms at most).
    const rest = total - 50;
    const interval = Math.max(10, Math.min(100, Math.floor(outageMs / rest)));
    let n = 50;
    while (Date.now() - t0 < outageMs && n < total) {
      write(n++);
      await sleep(interval);
    }
    const left = outageMs - (Date.now() - t0);
    if (left > 0) await sleep(left);
    const during = hooks().length - before;
    while (n < total) write(n++); // anything not yet written arrives as a burst while still down
    await hub.start();
    const t1 = Date.now();
    const recovered = await until(() => hooks().length >= total, recoverTimeoutMs);
    const recoverMs = Date.now() - t1;
    await sleep(1000); // time for any duplicate to show up

    // Per host: payload n strictly increasing in hub arrival order, and the hub's seq increasing.
    const hosts = new Map();
    for (const id of hub.order) {
      const a = hub.accepted.get(id);
      if (a.kind !== "hook") continue;
      if (!hosts.has(a.host)) hosts.set(a.host, []);
      hosts.get(a.host).push(a);
    }
    const order = [...hosts.entries()].map(([h, list]) => {
      const inOrder = list.every(
        (a, i) => i === 0 || (a.payload.n > list[i - 1].payload.n && a.seq > list[i - 1].seq),
      );
      return `${h}=${inOrder ? "ok" : "BROKEN"}`;
    });
    const all = hooks();
    const unique = new Set(all.map((a) => a.payload.n));
    const duplicates = hub.conflicts + (all.length - unique.size);
    const seqs = [...hub.accepted.values()].map((a) => a.seq).sort((x, y) => x - y);
    const gaps = seqs.filter((s, i) => s !== i).length;
    return {
      sent,
      accepted: all.length,
      duplicates,
      gaps,
      order: order.join(","),
      orderOk: order.length > 0 && order.every((o) => o.endsWith("=ok")),
      delivered_during_outage: during,
      outage_ms: outageMs,
      recovered,
      recover_ms: recoverMs,
      resent_ids: hub.resentIds,
    };
  } finally {
    await killTree(daemon);
    await hub.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = await runDaemonOutage();
  console.log(
    `R1.5 daemon outage ${r.outage_ms}ms via probe daemon run: sent=${r.sent} accepted=${r.accepted} duplicates=${r.duplicates} gaps=${r.gaps} order=${r.order} delivered_during_outage=${r.delivered_during_outage} resent_ids=${r.resent_ids} recover_ms=${r.recover_ms}`,
  );
  const pass =
    r.recovered &&
    r.accepted === r.sent &&
    r.duplicates === 0 &&
    r.gaps === 0 &&
    r.orderOk &&
    r.delivered_during_outage === 0;
  console.log(`RESULT ${pass ? "pass" : "fail"}`);
  process.exit(pass ? 0 : 1);
}
