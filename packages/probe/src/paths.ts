// Hook-safe paths. This module is bundled into dist/hook.mjs, so it must not read SESSIONDECK_HOME
// or XDG_STATE_HOME: the probe home comes from `--home` in argv (written by `probe install`), else
// from the platform default below. Env vars in a repo's settings.local.json must not be able to
// redirect where the hook writes.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function currentPathEnv(): PathEnv {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * Platform default probe home. Windows: <homedir>\AppData\Local\sessiondeck (LOCALAPPDATA is
 * deliberately not read: an env var must not move where the hook writes, and it matches the CLI
 * default). Elsewhere, including WSL2 (which sees Linux paths): ~/.local/state/sessiondeck.
 */
export function defaultProbeHome(e: PathEnv = currentPathEnv()): string {
  if (e.platform === "win32") {
    return win32.join(e.home, "AppData", "Local", "sessiondeck");
  }
  return posix.join(e.home, ".local", "state", "sessiondeck");
}

/** Child of a probe home, joined in the style of the given platform. */
export function homeChild(
  home: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return (platform === "win32" ? win32 : posix).join(home, name);
}

export function spoolDir(home: string, platform?: NodeJS.Platform): string {
  return homeChild(home, "spool", platform);
}

export function hookErrorsLog(home: string, platform?: NodeJS.Platform): string {
  return homeChild(home, "hook-errors.log", platform);
}

/** Day file name, by UTC date: yyyy-mm-dd.jsonl. */
export function dayFileName(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 10)}.jsonl`;
}

// Daemon paths (all under the probe home; nothing elsewhere).

export function daemonDir(home: string, platform?: NodeJS.Platform): string {
  return homeChild(home, "daemon", platform);
}

export function daemonChild(home: string, name: string, platform?: NodeJS.Platform): string {
  return homeChild(daemonDir(home, platform), name, platform);
}

/** Daemon-originated envelopes (heartbeat, liveness, transcript): day files, single writer. */
export function outboxDir(home: string, platform?: NodeJS.Platform): string {
  return daemonChild(home, "outbox", platform);
}

/** Batches the hub refused with a non-retryable 4xx. */
export function rejectedDir(home: string, platform?: NodeJS.Platform): string {
  return daemonChild(home, "rejected", platform);
}

export function daemonLogPath(home: string, platform?: NodeJS.Platform): string {
  return daemonChild(home, "daemon.log", platform);
}

export function daemonLockPath(home: string, platform?: NodeJS.Platform): string {
  return daemonChild(home, "daemon.lock", platform);
}

/** Cursors, next_seq and the pending-batch journal, in one atomically replaced file. */
export function daemonStatePath(home: string, platform?: NodeJS.Platform): string {
  return daemonChild(home, "state.json", platform);
}

export function probeConfigFile(home: string, platform?: NodeJS.Platform): string {
  return homeChild(home, "probe.json", platform);
}
