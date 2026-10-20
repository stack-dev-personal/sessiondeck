import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function currentPathEnv(): PathEnv {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * Probe home directory. SESSIONDECK_HOME wins (tests). Windows: %LOCALAPPDATA%\sessiondeck.
 * Elsewhere (including hooks inside WSL2, which see Linux paths): $XDG_STATE_HOME/sessiondeck or
 * ~/.local/state/sessiondeck.
 */
export function probeHome(e: PathEnv = currentPathEnv()): string {
  const override = e.env["SESSIONDECK_HOME"];
  if (override) return override;
  if (e.platform === "win32") {
    const base = e.env["LOCALAPPDATA"] || win32.join(e.home, "AppData", "Local");
    return win32.join(base, "sessiondeck");
  }
  const state = e.env["XDG_STATE_HOME"] || posix.join(e.home, ".local", "state");
  return posix.join(state, "sessiondeck");
}

/** Child of the probe home, joined in the style the home itself was resolved in. */
function child(e: PathEnv, name: string): string {
  const home = probeHome(e);
  if (e.env["SESSIONDECK_HOME"]) return join(home, name);
  return (e.platform === "win32" ? win32 : posix).join(home, name);
}

export function spoolDir(e: PathEnv = currentPathEnv()): string {
  return child(e, "spool");
}

export function hookErrorsLog(e: PathEnv = currentPathEnv()): string {
  return child(e, "hook-errors.log");
}

/** Day file name, by UTC date: yyyy-mm-dd.jsonl. */
export function dayFileName(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 10)}.jsonl`;
}
