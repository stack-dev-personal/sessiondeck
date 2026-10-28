// Foreground daemon runner shared by dist/daemon.mjs and `probe daemon run`:
// `[--home <dir>] [--stderr]`. Runs until SIGINT/SIGTERM (or until the console closes). A second
// instance for the same home exits 0.
import { readConfig } from "../config/config.ts";
import { defaultProbeHome, probeConfigFile } from "../paths.ts";
import { defaultComponents } from "./components.ts";
import { parseBackoffCapMs, parseHeartbeatMs } from "./env-knobs.ts";
import { startDaemon } from "./index.ts";

export async function runDaemon(argv: string[]): Promise<void> {
  const homeIdx = argv.indexOf("--home");
  const home =
    homeIdx >= 0 && argv[homeIdx + 1] ? (argv[homeIdx + 1] as string) : defaultProbeHome();

  // Test and harness knobs (the defaults are the product behavior): SESSIONDECK_BACKOFF_CAP_MS
  // shortens the 30 s retry cap, SESSIONDECK_HEARTBEAT_MS the 30 s heartbeat interval.
  const backoffCapMs = parseBackoffCapMs(process.env["SESSIONDECK_BACKOFF_CAP_MS"]);
  const heartbeatMs = parseHeartbeatMs(process.env["SESSIONDECK_HEARTBEAT_MS"]);
  // The archive importer is configured once at start (restart the daemon to change it). A config
  // that does not validate is reported and the importer stays off; hook forwarding is unaffected.
  const archive = await readConfig(probeConfigFile(home)).then(
    (c) => c?.archive,
    (e: unknown) => {
      process.stderr.write(
        `sessiondeck archive import off: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return undefined;
    },
  );
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      home,
      stderr: argv.includes("--stderr"),
      components: defaultComponents(home, process.env, archive),
      onLockLost: () => process.exit(0),
      ...(backoffCapMs !== undefined ? { backoffCapMs } : {}),
      ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    });
  } catch (e) {
    // E.g. a takeover by another starter that never finished: not "already running", so non-zero.
    process.stderr.write(
      `sessiondeck daemon did not start: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
  if (!daemon) {
    process.stderr.write("sessiondeck daemon already running for this home\n");
    process.exit(0);
  }
  const d = daemon;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void d.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGBREAK", shutdown);
  // Keep the process alive; the forwarder loop holds timers, this covers idle gaps.
  setInterval(() => undefined, 1 << 30);
}
