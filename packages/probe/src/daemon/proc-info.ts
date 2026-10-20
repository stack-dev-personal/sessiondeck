// Process lookup and the parent walk for the liveness component (R1.7).
//
// Provenance (exact):
//   findParentPID is ported from ccmonitor.
//     Source repo: https://github.com/martinwickman/ccmonitor, commit 88f7d1adfbff82a790fbb37346cc70d276548f5c
//     Path:        internal/hook/hook.go (findParentPID), as quoted in docs/planning/01-architecture.md
//                  section 3.2 (the Go file itself was not opened by this work)
//     License:     MIT, Copyright (c) 2026 Martin Wickman
//     Changes:     Go to TypeScript. The process table is an injectable lookup (Linux reads /proc, macOS
//                  runs /bin/ps, Windows runs one hidden PowerShell CIM snapshot) instead of direct OS
//                  calls, and every lookup is asynchronous. The walk starts from the pid the hook
//                  reported rather than os.Getppid(), and it returns nothing when the chain ends in a
//                  shell or a dead process instead of returning a shell pid, so the caller never tracks
//                  a transient shell.
//   isShellProcess and the SHELLS list are original. They were written from a behavioural description
//   (the interpreters a hook command line runs under on Linux, macOS, Windows); no ccmonitor source
//   was copied for them.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Executable name without directory, lower-cased, without a trailing .exe. */
  name: string;
  /** Opaque process start token, equal across reads of the same process, when the OS gives one. */
  start?: string;
  /** The start as epoch milliseconds, when it can be derived (used to reject a process younger than the hook). */
  startMs?: number;
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
  /**
   * The chain pid, its parent, its grandparent ... (at most MAX_WALK entries, stops at a missing
   * process or a cycle) from ONE process-table read. Lets a spawning platform walk with one child
   * process instead of one per step. `notBefore` (epoch ms, the hook line's ts) is the oldest
   * process-table read that may answer: a shared snapshot taken before it could resolve a pid the OS
   * has since handed to a new process, so a platform that caches reads must take a new one.
   */
  ancestry?(pid: number, notBefore?: number): Promise<ProcInfo[]>;
  /**
   * Several processes from ONE process-table read (a pid that does not exist is absent from the
   * map). The monitor uses it for the periodic start re-check, so N entries cost one child process.
   * undefined when the process table could not be read (not the same as "no such process").
   */
  lookupMany?(pids: number[]): Promise<Map<number, ProcInfo> | undefined>;
  /** True when lookup/ancestry start a child process; the monitor then rate-limits them. */
  spawns?: boolean;
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
 * findParent. `pid` is the process the hook reported as its parent. If that is not a shell it is
 * returned as is. Otherwise walk up through shells to the first non-shell ancestor that is alive.
 * Returns undefined when there is no such ancestor, the chain is unreadable, or a cycle is found,
 * so the caller can leave the session untracked rather than watch a shell that will exit on its own.
 */
export async function findParent(
  pid: number,
  procs: Pick<ProcLookup, "lookup" | "ancestry">,
  isAlive: (pid: number) => boolean,
  notBefore?: number,
): Promise<ProcInfo | undefined> {
  if (procs.ancestry !== undefined) {
    for (const info of (await procs.ancestry(pid, notBefore)).slice(0, MAX_WALK)) {
      if (info.pid <= 1) return undefined;
      if (!isShellProcess(info.name)) return isAlive(info.pid) ? info : undefined;
    }
    return undefined;
  }
  let cur = pid;
  const seen = new Set<number>();
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (cur <= 1 || seen.has(cur)) return undefined;
    seen.add(cur);
    const info = await procs.lookup(cur);
    if (info === undefined) return undefined;
    if (!isShellProcess(info.name)) return isAlive(cur) ? info : undefined;
    cur = info.ppid;
  }
  return undefined;
}

/** findParentPID: the pid of findParent, 0 when there is none. */
export async function findParentPID(
  pid: number,
  procs: Pick<ProcLookup, "lookup" | "ancestry">,
  isAlive: (pid: number) => boolean,
): Promise<number> {
  return (await findParent(pid, procs, isAlive))?.pid ?? 0;
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

/** Boot time in epoch ms from `btime` in /proc/stat, or undefined. */
function readBtimeMs(procRoot: string): number | undefined {
  try {
    const m = /^btime\s+(\d+)/m.exec(readFileSync(path.join(procRoot, "stat"), "utf8"));
    return m?.[1] === undefined ? undefined : Number(m[1]) * 1000;
  } catch {
    return undefined;
  }
}

export function linuxProcLookup(procRoot = "/proc"): ProcLookup {
  let btime: number | undefined | null = null;
  const withMs = (pid: number, p: { ppid: number; name: string; start: string }): ProcInfo => {
    if (btime === null) btime = readBtimeMs(procRoot);
    // starttime is in clock ticks since boot; USER_HZ is 100 on every Linux Claude Code runs on.
    return {
      pid,
      ...p,
      ...(btime !== undefined ? { startMs: btime + Number(p.start) * 10 } : {}),
    };
  };
  const readSync = (pid: number): ProcInfo | undefined => {
    try {
      const p = parseProcStat(readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
      return p === undefined ? undefined : withMs(pid, p);
    } catch {
      return undefined;
    }
  };
  return {
    async lookup(pid) {
      try {
        const p = parseProcStat(await readFile(path.join(procRoot, String(pid), "stat"), "utf8"));
        return p === undefined ? undefined : withMs(pid, p);
      } catch {
        return undefined;
      }
    },
    cheapStart: (pid) => readSync(pid)?.start,
  };
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = 64 * 1024,
  onError?: (err: { code?: string | number | null; message: string }) => void,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: "utf8" },
        (err, stdout) => {
          if (err) onError?.(err);
          resolve(err ? undefined : stdout);
        },
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
  const start = t.slice(1, 6).join(" ");
  const ms = Date.parse(start);
  return {
    pid,
    ppid,
    start,
    ...(Number.isFinite(ms) ? { startMs: ms } : {}),
    name: normalizeProcName(t.slice(6).join(" ")),
  };
}

/** The absolute ps on macOS, never found through PATH. */
export const PS_PATH = "/bin/ps";

export function psLookup(timeoutMs = 3000): ProcLookup {
  return {
    spawns: true,
    async lookup(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const out = await run(PS_PATH, ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], timeoutMs);
      return out === undefined ? undefined : parsePs(out, pid);
    },
  };
}

/** .NET ticks (100 ns since 0001-01-01 UTC) to epoch ms, or undefined for 0 or garbage. */
export function ticksToMs(ticks: string | undefined): number | undefined {
  if (ticks === undefined || !/^\d+$/.test(ticks)) return undefined;
  const ms = Number(BigInt(ticks) / 10000n) - 62135596800000;
  return ms > 0 ? ms : undefined;
}

function winInfo(pidS: string, ppidS: string, name: string, start: string | undefined) {
  const pid = Number(pidS);
  const ppid = Number(ppidS);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || name === "") return undefined;
  const ms = ticksToMs(start);
  return {
    pid,
    ppid,
    name: normalizeProcName(name),
    ...(start ? { start } : {}),
    ...(ms !== undefined ? { startMs: ms } : {}),
  } satisfies ProcInfo;
}

/** Output of the single-process Windows query: `ppid|name|creationdate-ticks`. */
export function parseWinLine(out: string, pid: number): ProcInfo | undefined {
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes("|"));
  if (line === undefined) return undefined;
  const [ppid, name, start] = line.split("|");
  return winInfo(String(pid), ppid ?? "", name ?? "", start);
}

/** Output of the snapshot query: one `pid|ppid|name|ticks` line per process. */
export function parseWinSnapshot(out: string): Map<number, ProcInfo> {
  const m = new Map<number, ProcInfo>();
  for (const raw of out.split(/\r?\n/)) {
    const [pid, ppid, name, start] = raw.trim().split("|");
    if (pid === undefined || ppid === undefined || name === undefined) continue;
    const info = winInfo(pid, ppid, name, start);
    if (info !== undefined) m.set(info.pid, info);
  }
  return m;
}

/** The chain pid, parent, grandparent ... from a snapshot; stops at a gap, pid <= 1, or a cycle. */
export function chainFromSnapshot(snap: Map<number, ProcInfo>, pid: number): ProcInfo[] {
  const chain: ProcInfo[] = [];
  const seen = new Set<number>();
  let cur = pid;
  while (chain.length < MAX_WALK && cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    const info = snap.get(cur);
    if (info === undefined) break;
    chain.push(info);
    cur = info.ppid;
  }
  return chain;
}

const WIN_PS_REL = "System32/WindowsPowerShell/v1.0/powershell.exe";

/**
 * The PowerShell to run: the pinned C:/Windows install; the SystemRoot environment variable is a
 * fallback only when the pinned file is missing and the variable's own file exists.
 */
export function resolvePowerShell(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const pinned = `C:/Windows/${WIN_PS_REL}`;
  if (exists(pinned)) return pinned;
  const root = env["SystemRoot"];
  if (root !== undefined && root !== "") {
    const alt = `${root.replaceAll("\\", "/")}/${WIN_PS_REL}`;
    if (exists(alt)) return alt;
  }
  return pinned;
}

const WIN_FIELDS =
  `"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|" + ` +
  `$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 })`;

/** A snapshot younger than this is reused by every lookup in a burst. */
export const SNAPSHOT_TTL_MS = 2000;
/** A cached snapshot that lacks the asked-for pid is refreshed only when it is older than this. */
const SNAPSHOT_REFRESH_MIN_MS = 300;
const SNAPSHOT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Windows: hidden, time-limited PowerShell CIM queries. `lookup` reads one process; `ancestry` and
 * `lookupMany` read the whole table once (shared for SNAPSHOT_TTL_MS by every caller, so a burst of
 * registrations or re-checks costs one child process) and walk it in JS. The daemon calls these
 * only when a pid is registered or re-checked, never on the 10 s liveness check, and the monitor
 * rate-limits them. No admin rights are needed to read Win32_Process for the user's own processes,
 * and nothing is written. `log` hears about a snapshot that overflowed its buffer or timed out.
 */
export function windowsLookup(
  timeoutMs = 8000,
  powershell?: string,
  log?: (msg: string) => void,
  nowFn: () => number = () => Date.now(),
): ProcLookup {
  const ps = powershell ?? resolvePowerShell();
  const args = (script: string): string[] => [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
  const snapScript =
    `Get-CimInstance Win32_Process | ForEach-Object { ` +
    `[Console]::Out.WriteLine(${WIN_FIELDS}) }`;
  let cache: { at: number; p: Promise<Map<number, ProcInfo> | undefined> } | undefined;
  /** One process-table read; maxAge < 0 forces a new one. Concurrent callers share the same read. */
  const snap = (maxAge: number): Promise<Map<number, ProcInfo> | undefined> => {
    const t = nowFn();
    if (cache !== undefined && maxAge >= 0 && t - cache.at <= maxAge) return cache.p;
    const p = (async (): Promise<Map<number, ProcInfo> | undefined> => {
      const out = await run(ps, args(snapScript), timeoutMs, SNAPSHOT_MAX_BUFFER, (err) => {
        const over = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        log?.(
          over
            ? `process snapshot exceeded ${SNAPSHOT_MAX_BUFFER} bytes; start checks are skipped`
            : `process snapshot failed: ${err.code ?? err.message}`,
        );
      });
      return out === undefined ? undefined : parseWinSnapshot(out);
    })();
    const mine = { at: t, p };
    cache = mine;
    void p.then((m) => {
      if (m === undefined && cache === mine) cache = undefined; // never cache a failure
    });
    return p;
  };
  return {
    spawns: true,
    async lookup(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const script =
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        `if ($p) { [Console]::Out.WriteLine("$($p.ParentProcessId)|$($p.Name)|$(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().Ticks } else { 0 })") }`;
      const out = await run(ps, args(script), timeoutMs);
      return out === undefined ? undefined : parseWinLine(out, pid);
    },
    async ancestry(pid, notBefore) {
      if (!Number.isInteger(pid) || pid <= 1) return [];
      // A snapshot begun before the hook line may name a pid that has since been reused.
      const stale = cache !== undefined && notBefore !== undefined && cache.at < notBefore;
      const age = cache === undefined ? 0 : nowFn() - cache.at;
      let s = await snap(stale ? -1 : SNAPSHOT_TTL_MS);
      let chain = s === undefined ? [] : chainFromSnapshot(s, pid);
      // A shared snapshot older than the process being walked cannot contain it: read a new one.
      if (chain.length === 0 && s !== undefined && age > SNAPSHOT_REFRESH_MIN_MS) {
        s = await snap(-1);
        chain = s === undefined ? [] : chainFromSnapshot(s, pid);
      }
      return chain;
    },
    async lookupMany(pids) {
      const out = new Map<number, ProcInfo>();
      const s = await snap(SNAPSHOT_TTL_MS);
      if (s === undefined) return undefined;
      for (const pid of pids) {
        const i = s.get(pid);
        if (i !== undefined) out.set(pid, i);
      }
      return out;
    },
  };
}

export function defaultProcLookup(
  platform: NodeJS.Platform = process.platform,
  log?: (msg: string) => void,
): ProcLookup {
  if (platform === "linux") return linuxProcLookup();
  if (platform === "win32") return windowsLookup(undefined, undefined, log);
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
