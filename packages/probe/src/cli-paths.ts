// CLI-only paths (install, uninstall, config). Not imported by the hook bundle: this is the only
// place SESSIONDECK_HOME is read, so tests can redirect the CLI without touching the real home.
import { join } from "node:path";
import { type PathEnv, currentPathEnv, defaultProbeHome } from "./paths.ts";

export type { PathEnv };
export { currentPathEnv };

/** Probe home for the CLI: SESSIONDECK_HOME if set (tests), else the platform default. */
export function probeHome(e: PathEnv = currentPathEnv()): string {
  return e.env["SESSIONDECK_HOME"] || defaultProbeHome(e);
}

/** Probe config file (hub URL, token, host). Never inside the Claude settings directory. */
export function probeConfigPath(e: PathEnv = currentPathEnv()): string {
  return join(probeHome(e), "probe.json");
}

/** Records what `probe install` changed, so `probe uninstall` can restore it exactly. */
export function installStatePath(e: PathEnv = currentPathEnv()): string {
  return join(probeHome(e), "install-state.json");
}

/** Claude Code settings file: CLAUDE_CONFIG_DIR/settings.json if set, else the default user dir. */
export function claudeSettingsPath(e: PathEnv = currentPathEnv()): string {
  const dir = e.env["CLAUDE_CONFIG_DIR"];
  if (dir) return join(dir, "settings.json");
  return join(e.home, ".claude", "settings.json");
}
