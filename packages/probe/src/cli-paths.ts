// CLI-only paths (install, uninstall, config). Not imported by the hook bundle. The probe home comes
// from an explicit `--home <dir>` flag or the platform default; no environment variable moves it
// (a repo-controlled "env" in .claude/settings.json must not be able to).
import { join, win32 } from "node:path";
import { realResolve } from "./install/real-path.ts";
import { type PathEnv, currentPathEnv, defaultProbeHome } from "./paths.ts";

export type { PathEnv };
export { currentPathEnv };

/**
 * CLI default home. On Windows this is <homedir>\\AppData\\Local\\sessiondeck and never reads
 * LOCALAPPDATA (an env var must not move where the token is written). Elsewhere it is the
 * shared platform default.
 */
export function cliDefaultHome(e: PathEnv): string {
  if (e.platform === "win32") return win32.join(e.home, "AppData", "Local", "sessiondeck");
  return defaultProbeHome(e);
}

/**
 * Probe home for the CLI: the explicit --home flag (symlinks and Windows 8.3 short names expanded,
 * so the spelling matches the one written into the hooks), else the CLI default.
 */
export function probeHome(e: PathEnv = currentPathEnv(), homeFlag?: string): string {
  return homeFlag ? realResolve(homeFlag) : cliDefaultHome(e);
}

/** Probe config file (hub URL, token, host). Never inside the Claude settings directory. */
export function probeConfigPath(e: PathEnv = currentPathEnv(), homeFlag?: string): string {
  return join(probeHome(e, homeFlag), "probe.json");
}

/** Records what `probe install` changed, so `probe uninstall` can restore it exactly. */
export function installStatePath(e: PathEnv = currentPathEnv(), homeFlag?: string): string {
  return join(probeHome(e, homeFlag), "install-state.json");
}

/** Claude Code settings file: CLAUDE_CONFIG_DIR/settings.json if set, else the default user dir. */
export function claudeSettingsPath(e: PathEnv = currentPathEnv()): string {
  const dir = e.env["CLAUDE_CONFIG_DIR"];
  if (dir) return join(dir, "settings.json");
  return join(e.home, ".claude", "settings.json");
}
