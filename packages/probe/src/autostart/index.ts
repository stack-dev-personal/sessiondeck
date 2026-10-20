// `probe daemon install | uninstall [--home <dir>]`. Windows: Task Scheduler logon task. Linux:
// systemd user unit. macOS and anything else: not supported yet (non-zero).
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { probeHome } from "../cli-paths.ts";
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
  return { platform: process.platform, env: process.env, home, userName };
}

const USAGE =
  "usage: probe daemon install|uninstall [--home <dir>] [--task-name <name>] [--no-start]";

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
