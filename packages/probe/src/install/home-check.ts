import { dirname } from "node:path";
import { homeRefusal } from "../autostart/index.ts";
import { type AutostartEnv, realExec, realFs } from "../autostart/types.ts";
import type { PathEnv } from "../paths.ts";

const WORLD_OR_GROUP_WRITABLE = 0o022;
const STICKY = 0o1000;

type StatFn = (path: string) => Promise<{ uid: number; mode: number } | undefined>;

/**
 * POSIX only. The nearest existing ancestor of `home` (its parent, or higher when the parent is
 * missing too) must be owned by `uid` or root and not group/world writable unless sticky; else
 * another user could rename the directory we are about to create or already use.
 * Pure over `stat` and `uid` so it is testable on any OS.
 */
export async function parentRefusal(
  home: string,
  uid: number | undefined,
  stat: StatFn,
): Promise<string | undefined> {
  let dir = dirname(home);
  for (;;) {
    const st = await stat(dir);
    if (st) {
      if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
        return `the parent ${dir} of ${home} is owned by another user; they could swap the directory`;
      }
      if ((st.mode & WORLD_OR_GROUP_WRITABLE) !== 0 && (st.mode & STICKY) === 0) {
        return `the parent ${dir} of ${home} is group or world writable (and not sticky); another user could swap the directory`;
      }
      return undefined;
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

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
  return parentRefusal(home, uid, (p) => realFs.statPath(p));
}
