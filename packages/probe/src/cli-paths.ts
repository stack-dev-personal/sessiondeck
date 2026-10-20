// CLI-only paths (install, uninstall, config). Not imported by the hook bundle. The probe home comes
// from an explicit `--home <dir>` flag or the platform default; no environment variable moves it
// (a repo-controlled "env" in .claude/settings.json must not be able to).
import { join, resolve } from "node:path";
import { type PathEnv, currentPathEnv, defaultProbeHome } from "./paths.ts";

export type { PathEnv };
export { currentPathEnv };

/** Probe home for the CLI: the explicit --home flag, else the platform default. */
export function probeHome(e: PathEnv = currentPathEnv(), homeFlag?: string): string {
  return homeFlag ? resolve(homeFlag) : defaultProbeHome(e);
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
