// Stops the daemon that is running for a probe home, on Windows, after the scheduled task was ended.
// `schtasks /End` kills wscript.exe (the launcher) but not necessarily the node.exe it started, which
// would keep the daemon lock and leave the old daemon unsupervised while a new launcher's daemon
// exits 0 at lock contention. So install (re-register) and uninstall stop the daemon itself:
//   1. read the highest-generation lock file in <home>\daemon (daemon.lock[.N]) for the pid;
//   2. require the lock to have been touched recently (the daemon touches it every 10 s), so a stale
//      file whose pid was reused by something else is never acted on;
//   3. require that the pid's image is node.exe (tasklist, CSV: locale-independent);
//   4. taskkill /PID <pid> /F (the daemon has no window to close; its state is written atomically, and
//      a killed daemon's lock is judged stale by the next one), then wait up to 10 s for it to go.
// All commands are exec form from the fixed System32 directory.
import { win32 } from "node:path";
import { daemonDir } from "../paths.ts";
import { type AutostartDeps } from "./types.ts";
import { system32 } from "./windows-paths.ts";

/** A live daemon touches its lock every 10 s; older than this the lock is not evidence of a process. */
export const LOCK_FRESH_MS = 60_000;
export const STOP_WAIT_MS = 10_000;
const POLL_MS = 250;

/** Highest generation among daemon.lock and daemon.lock.<n> (bare name is generation 0). */
export function highestLockFile(names: string[]): string | undefined {
  let best: { n: number; name: string } | undefined;
  for (const name of names) {
    const m = /^daemon\.lock(?:\.(\d+))?$/.exec(name);
    if (!m) continue;
    const n = m[1] === undefined ? 0 : Number(m[1]);
    if (!best || n > best.n) best = { n, name };
  }
  return best?.name;
}

export function lockPid(text: string): number | undefined {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number.parseInt(t, 10);
  try {
    const o = JSON.parse(t) as { pid?: unknown };
    return typeof o.pid === "number" && Number.isInteger(o.pid) ? o.pid : undefined;
  } catch {
    return undefined;
  }
}

export const tasklistArgs = (pid: number): string[] => [
  "/FI",
  `PID eq ${String(pid)}`,
  "/FO",
  "CSV",
  "/NH",
];
export const taskkillArgs = (pid: number): string[] => ["/PID", String(pid), "/F"];

/** True when tasklist's CSV lists this pid with image node.exe. */
export function isNodeProcess(csv: string, pid: number): boolean {
  return csv
    .split("\0")
    .join("")
    .split(/\r?\n/)
    .some((ln) => {
      const f = ln.split('","').map((x) => x.replace(/^"|"$/g, ""));
      return f.length >= 2 && f[0]?.toLowerCase() === "node.exe" && f[1] === String(pid);
    });
}

/**
 * Returns true when no daemon of this home is running afterwards (none found, or stopped), false
 * when one was found and could not be stopped (the reason is on d.err).
 */
export async function stopDaemonWindows(d: AutostartDeps, probeHome: string): Promise<boolean> {
  const dir = daemonDir(probeHome, "win32");
  const lockName = highestLockFile(await d.fs.list(dir));
  if (!lockName) return true;
  const file = win32.join(dir, lockName);
  const text = await d.fs.read(file);
  const pid = text === undefined ? undefined : lockPid(text);
  if (pid === undefined || pid <= 1 || pid === process.pid) return true; // tombstone or unreadable
  const now = d.now ?? Date.now;
  const st = await d.fs.statPath(file);
  if (!st || st.mtimeMs === undefined || now() - st.mtimeMs > LOCK_FRESH_MS) return true;
  const tasklist = system32(d.e, "tasklist.exe");
  const probe = await d.exec(tasklist, tasklistArgs(pid));
  if (probe.code !== 0 || !isNodeProcess(probe.stdout, pid)) return true;
  const k = await d.exec(system32(d.e, "taskkill.exe"), taskkillArgs(pid));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + STOP_WAIT_MS;
  for (;;) {
    const again = await d.exec(tasklist, tasklistArgs(pid));
    if (again.code === 0 && !isNodeProcess(again.stdout, pid)) return true;
    if (now() >= deadline) break;
    await sleep(POLL_MS);
  }
  const why =
    k.code === 0
      ? "it did not exit within 10 s"
      : (k.stderr.trim() || "taskkill failed").slice(0, 200);
  d.err(`probe: could not stop the running daemon (pid ${String(pid)}): ${why}`);
  return false;
}
