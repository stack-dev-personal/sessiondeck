import { dirname } from "node:path";
import { homeRefusal } from "../autostart/index.ts";
import { type AutostartEnv, realExec, realFs } from "../autostart/types.ts";
import type { PathEnv } from "../paths.ts";

const WORLD_OR_GROUP_WRITABLE = 0o022;
const STICKY = 0o1000;

/**
 * Why this probe home may not hold the exes Claude Code runs on every hook, or undefined when it
 * may. Same rule as `probe daemon install` (autostart homeRefusal): on Windows the home must be the
 * profile default or beneath it (a folder such as C:\sd inherits "Authenticated Users: Modify");
 * on POSIX it must be owned by this user and not group/world writable, and so must its parent
 * (a sticky parent such as /tmp is fine: others cannot rename our entry).
 */
export async function exeHomeRefusal(e: PathEnv, home: string): Promise<string | undefined> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const env: AutostartEnv = {
    platform: e.platform,
    env: e.env,
    home: e.home,
    userName: e.env["USERNAME"] ?? e.env["USER"] ?? "",
    ...(uid !== undefined ? { uid } : {}),
  };
  const deps = { e: env, out: () => undefined, err: () => undefined, exec: realExec, fs: realFs };
  const refusal = await homeRefusal(e.platform, home, env, deps, true);
  if (refusal || e.platform === "win32") return refusal;
  const parent = dirname(home);
  const st = await realFs.statPath(parent);
  if (st && (st.mode & WORLD_OR_GROUP_WRITABLE) !== 0 && (st.mode & STICKY) === 0) {
    return `the parent of ${home} is group or world writable (and not sticky); another user could swap the directory`;
  }
  return undefined;
}
