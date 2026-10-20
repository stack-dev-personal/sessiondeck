// `probe daemon install | uninstall [--home <dir>]`. Windows: Task Scheduler logon task. Linux:
// systemd user unit. macOS and anything else: not supported yet (non-zero).
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { cliDefaultHome, probeHome } from "../cli-paths.ts";
import { realResolve } from "../install/real-path.ts";
import { installSystemd, uninstallSystemd } from "./systemd.ts";
import {
  type AutostartDeps,
  type AutostartEnv,
  type AutostartIo,
  type DaemonCommand,
  type ExecFn,
  type AutostartFs,
  realExec,
  realFs,
} from "./types.ts";
import { installWindows, uninstallWindows } from "./windows.ts";

export interface AutostartRun extends AutostartIo {
  e: AutostartEnv;
  /** Directory holding daemon.mjs (dist/). */
  distDir: string;
  /** Absolute node binary. */
  nodePath: string;
  exec?: ExecFn;
  fs?: AutostartFs;
}

export function currentAutostartEnv(): AutostartEnv {
  const home = homedir();
  let userName = process.env["USERNAME"] ?? process.env["USER"] ?? "";
  try {
    userName = userInfo().username;
  } catch {
    // keep the environment's
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return {
    platform: process.platform,
    env: process.env,
    home,
    userName,
    ...(uid !== undefined ? { uid } : {}),
  };
}

const USAGE =
  "usage: probe daemon install|uninstall [--home <dir>] [--task-name <name>] [--no-start]";

const lc = (s: string): string => s.replace(/[\\/]+$/, "").toLowerCase();

/**
 * Why this probe home may not carry an autostart launcher, or undefined when it may. On Windows the
 * mode bits do nothing and no ACL is set, so the home must be the user's own default
 * (<home>\AppData\Local\sessiondeck, or beneath it), which inherits the profile's ACL; a shared
 * directory such as C:\sd could be swapped by another local user between write and registration.
 * On POSIX an existing home must be owned by this user and not group/world-writable.
 */
export async function homeRefusal(
  p: NodeJS.Platform,
  home: string,
  e: AutostartEnv,
  deps: AutostartDeps,
  real: boolean,
): Promise<string | undefined> {
  if (p === "win32") {
    const defs = [cliDefaultHome({ platform: p, env: e.env, home: e.home })];
    if (real) defs.push(realResolve(defs[0] as string));
    const h = lc(home.replace(/\//g, "\\"));
    const inside = defs.some((d0) => {
      const d = lc(d0.replace(/\//g, "\\"));
      return h === d || h.startsWith(`${d}\\`);
    });
    if (!inside || h.split("\\").includes("..")) {
      return `--home ${home} is outside ${defs[0] as string}; the daemon launcher runs at every logon, so on Windows it must live in your own profile (the default, or a folder beneath it)`;
    }
    return undefined;
  }
  const st = await deps.fs.statPath(home);
  if (!st) return undefined;
  if (e.uid !== undefined && st.uid !== e.uid) {
    return `--home ${home} is not owned by you; refusing to run a daemon from it`;
  }
  if ((st.mode & 0o022) !== 0) {
    return `--home ${home} is group or world writable; refusing to run a daemon from it (chmod go-w)`;
  }
  return undefined;
}

/** `argv` is what follows `daemon`: ["install" | "uninstall", ...flags]. Returns the exit code. */
export async function runAutostart(argv: string[], r: AutostartRun): Promise<number> {
  const verb = argv[0];
  let homeFlag: string | undefined;
  let taskName: string | undefined;
  let start = true;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--home" || a === "--task-name") {
      const v = argv[++i];
      if (!v) {
        r.err(`probe: ${a} needs a value`);
        return 2;
      }
      if (a === "--home") homeFlag = v;
      else taskName = v;
    } else if (a === "--no-start") start = false;
    else {
      r.err(`probe: unknown option ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (verb !== "install" && verb !== "uninstall") {
    r.err(USAGE);
    return 2;
  }
  const p = r.e.platform;
  if (p !== "win32" && p !== "linux") {
    r.err(
      `probe: daemon ${verb} is not supported yet on ${p === "darwin" ? "macOS" : p}; use \`probe daemon run\``,
    );
    return 1;
  }
  const deps: AutostartDeps = {
    e: r.e,
    out: r.out,
    err: r.err,
    exec: r.exec ?? realExec,
    fs: r.fs ?? realFs,
  };
  // Real runs spell the home as `probe install` does (symlinks and 8.3 names expanded); simulated
  // platforms (tests) keep the flag as given.
  const pe = { platform: p, env: r.e.env, home: r.e.home };
  const real = r.fs === undefined && p === process.platform;
  const home = homeFlag !== undefined && !real ? homeFlag : probeHome(pe, homeFlag);
  const cmd: DaemonCommand = {
    node: r.nodePath,
    script: (p === "win32" ? win32 : posix).join(r.distDir, "daemon.mjs"),
    probeHome: home,
  };
  try {
    if (verb === "install") {
      const refusal = await homeRefusal(p, home, r.e, deps, real);
      if (refusal) {
        r.err(`probe: ${refusal}`);
        return 1;
      }
    }
    if (verb === "install") {
      return p === "win32"
        ? await installWindows(deps, cmd, { ...(taskName ? { taskName } : {}), start })
        : await installSystemd(deps, cmd);
    }
    return p === "win32"
      ? await uninstallWindows(deps, home, taskName ? { taskName } : {})
      : await uninstallSystemd(deps);
  } catch (e) {
    r.err(`probe: daemon ${verb} failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
