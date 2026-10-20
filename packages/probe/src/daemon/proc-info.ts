// Process lookup and the parent walk for the liveness component (R1.7).
//
// Ported from ccmonitor.
//   Source repo: https://github.com/martinwickman/ccmonitor, commit 88f7d1adfbff82a790fbb37346cc70d276548f5c
//   Paths:       internal/hook/hook.go (findParentPID), internal/session/session.go (isShellProcess)
//   License:     MIT, Copyright (c) 2026 Martin Wickman
//   Changes:     Go to TypeScript. The process table is an injectable lookup (Linux reads /proc, macOS
//                runs `ps`, Windows runs one hidden PowerShell CIM query) instead of direct OS calls,
//                and every lookup is asynchronous. The walk starts from the pid the hook reported
//                rather than os.Getppid(), and it returns 0 when the chain ends in a shell or a dead
//                process instead of returning a shell pid, so the caller never tracks a transient
//                shell. The shell list is the interpreter names a Claude Code hook can run under on
//                Linux, macOS, and Windows (Git Bash, cmd, PowerShell).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Executable name without directory, lower-cased, without a trailing .exe. */
  name: string;
  /** Opaque process start token, equal across reads of the same process, when the OS gives one. */
  start?: string;
}

export interface ProcLookup {
  /** One process, or undefined when it does not exist or cannot be read. Never throws. */
  lookup(pid: number): Promise<ProcInfo | undefined>;
  /**
   * Start token only, synchronous and cheap enough for every 10 s tick (a /proc read). Absent on
   * platforms where that needs a child process (Windows, macOS): the tick then relies on the
   * sessions file for pid-reuse protection.
   */
  cheapStart?(pid: number): string | undefined;
}

const SHELLS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "busybox",
  "cmd",
  "pwsh",
  "powershell",
  "wsl",
]);

export function normalizeProcName(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** isShellProcess: true for the interpreters a hook command line is run through. */
export function isShellProcess(name: string): boolean {
  return SHELLS.has(normalizeProcName(name));
}

/** The source's safety limit on the walk. */
export const MAX_WALK = 20;

/**
 * findParentPID. `pid` is the process the hook reported as its parent. If that is not a shell it is
 * returned as is. Otherwise walk up through shells to the first non-shell ancestor that is alive.
 * Returns 0 when there is no such ancestor, the chain is unreadable, or a cycle is found, so the
 * caller can leave the session untracked rather than watch a shell that will exit on its own.
 */
export async function findParentPID(
  pid: number,
  procs: Pick<ProcLookup, "lookup">,
  isAlive: (pid: number) => boolean,
): Promise<number> {
  let cur = pid;
  const seen = new Set<number>();
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (cur <= 1 || seen.has(cur)) return 0;
    seen.add(cur);
    const info = await procs.lookup(cur);
    if (info === undefined) return 0;
    if (!isShellProcess(info.name)) return isAlive(cur) ? cur : 0;
    cur = info.ppid;
  }
  return 0;
}

/** Parses /proc/<pid>/stat: `pid (comm) state ppid ... starttime(field 22)`; comm may hold ")" . */
export function parseProcStat(
  text: string,
): { ppid: number; name: string; start: string } | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state); ppid is field 4; starttime is field 22.
  const ppid = Number(rest[1]);
  const start = rest[19];
  if (!Number.isInteger(ppid) || start === undefined || !/^\d+$/.test(start)) return undefined;
  return { ppid, name: normalizeProcName(text.slice(open + 1, close)), start };
}

export function linuxProcLookup(procRoot = "/proc"): ProcLookup {
  const readSync = (pid: number): ProcInfo | undefined => {
    try {
      const p = parseProcStat(readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
      return p === undefined ? undefined : { pid, ...p };
    } catch {
      return undefined;
    }
  };
  return {
    async lookup(pid) {
      try {
        const p = parseProcStat(await readFile(path.join(procRoot, String(pid), "stat"), "utf8"));
        return p === undefined ? undefined : { pid, ...p };
      } catch {
        return undefined;
      }
    },
    cheapStart: (pid) => readSync(pid)?.start,
  };
}

function run(file: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" },
        (err, stdout) => resolve(err ? undefined : stdout),
      );
    } catch {
      resolve(undefined);
    }
  });
}

/** macOS (and BSD): `ps -o ppid=,lstart=,comm= -p N`; lstart is five tokens. */
export function parsePs(out: string, pid: number): ProcInfo | undefined {
  const t = out.trim().split(/\s+/);
  if (t.length < 7) return undefined;
  const ppid = Number(t[0]);
  if (!Number.isInteger(ppid)) return undefined;
  return {
    pid,
    ppid,
    start: t.slice(1, 6).join(" "),
    name: normalizeProcName(t.slice(6).join(" ")),
  };
}

export function psLookup(timeoutMs = 3000): ProcLookup {
  return {
    async lookup(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const out = await run("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], timeoutMs);
      return out === undefined ? undefined : parsePs(out, pid);
    },
  };
}

/** Output of the Windows query below: `ppid|name|creationdate-ticks`. */
export function parseWinLine(out: string, pid: number): ProcInfo | undefined {
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes("|"));
  if (line === undefined) return undefined;
  const [ppid, name, start] = line.split("|");
  const n = Number(ppid);
  if (!Number.isInteger(n) || name === undefined || name === "") return undefined;
  return { pid, ppid: n, name: normalizeProcName(name), ...(start ? { start } : {}) };
}

/**
 * Windows: one hidden, time-limited PowerShell CIM query per lookup. The daemon calls lookup only
 * when a new pid is registered (a handful per session), never on the 10 s tick. No admin rights
 * are needed to read Win32_Process for the user's own processes, and nothing is written.
 */
export function windowsLookup(timeoutMs = 8000): ProcLookup {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  const ps = `${root.replaceAll("\\", "/")}/System32/WindowsPowerShell/v1.0/powershell.exe`;
  return {
    async lookup(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const script =
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        `if ($p) { [Console]::Out.WriteLine("$($p.ParentProcessId)|$($p.Name)|$($p.CreationDate.ToUniversalTime().Ticks)") }`;
      const out = await run(
        ps,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        timeoutMs,
      );
      return out === undefined ? undefined : parseWinLine(out, pid);
    },
  };
}

export function defaultProcLookup(platform: NodeJS.Platform = process.platform): ProcLookup {
  if (platform === "linux") return linuxProcLookup();
  if (platform === "win32") return windowsLookup();
  return psLookup();
}

/** process.kill(pid, 0): EPERM means the process exists but belongs to someone else, so alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
