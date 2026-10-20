// Second opinion for the liveness component: Claude Code's own per-session files (R1.7).
//
// ~/.claude/sessions/<pid>.json (under CLAUDE_CONFIG_DIR when set) is undocumented beyond "one small
// file per running session". Fields seen in anthropics/claude-code#100824: pid, sessionId, cwd,
// startedAt, procStart, status, updatedAt. There is no fixture in packages/contract/fixtures, so
// every field is optional here except what a lookup needs, extra fields are ignored, and a file of
// an unknown shape is skipped (logged once per daemon run, never an error).
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "./types.ts";

export interface SessionFile {
  pid: number;
  sessionId: string;
  /** Process start token as the file gives it (stringified), when present. */
  procStart?: string;
  startedAt?: string;
}

const MAX_FILES = 500;
export const MAX_FILE_BYTES = 64 * 1024;

/**
 * Reads one regular file without ever blocking or following a link: lstat must say "regular file"
 * (a symlink, FIFO, or device is skipped), the open is O_NONBLOCK (and O_NOFOLLOW on POSIX), the
 * opened descriptor is fstat-checked again (closes the stat/open race), and at most
 * MAX_FILE_BYTES + 1 bytes are read through it. Returns undefined for anything else or over the cap.
 */
export function readRegularFileCapped(file: string, maxBytes = MAX_FILE_BYTES): string | undefined {
  if (!lstatSync(file).isFile()) return undefined;
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, flags);
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    return n > maxBytes ? undefined : buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

export function sessionsDir(env: Record<string, string | undefined> = process.env): string {
  const base = env["CLAUDE_CONFIG_DIR"];
  return path.join(
    base !== undefined && base !== "" ? base : path.join(homedir(), ".claude"),
    "sessions",
  );
}

function token(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** One file's text to an entry, or undefined for any shape that lacks a usable pid and sessionId. */
export function parseSessionFile(text: string, fileName: string): SessionFile | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  const stem = /^(\d+)\.json$/.exec(fileName)?.[1];
  const pid = typeof r["pid"] === "number" ? r["pid"] : stem !== undefined ? Number(stem) : NaN;
  const sessionId = r["sessionId"];
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (stem !== undefined && Number(stem) !== pid) return undefined; // name and content disagree
  const procStart = token(r["procStart"]);
  const startedAt = token(r["startedAt"]);
  return {
    pid,
    sessionId,
    ...(procStart !== undefined ? { procStart } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

export class SessionsReader {
  private warned = false;
  private readonly dir: string;
  private readonly log: Logger;
  constructor(dir: string, log: Logger) {
    this.dir = dir;
    this.log = log;
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log("warn", `liveness: ${msg}; ignoring the sessions-file second opinion`);
  }

  /** All readable entries; [] when the directory is missing. Never throws. */
  readAll(): SessionFile[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SessionFile[] = [];
    let unusable = 0;
    for (const n of names.slice(0, MAX_FILES)) {
      try {
        const p = path.join(this.dir, n);
        const text = readRegularFileCapped(p);
        const e = text === undefined ? undefined : parseSessionFile(text, n);
        if (e === undefined) unusable += 1;
        else out.push(e);
      } catch {
        // file vanished between readdir and read: the session just ended
      }
    }
    if (out.length === 0 && unusable > 0)
      this.warnOnce(`${this.dir} has files of an unknown shape`);
    return out;
  }

  /** The entry of one pid, or undefined (missing, unreadable, or unknown shape). */
  readPid(pid: number): SessionFile | undefined {
    const n = `${pid}.json`;
    try {
      const p = path.join(this.dir, n);
      const text = readRegularFileCapped(p);
      return text === undefined ? undefined : parseSessionFile(text, n);
    } catch {
      return undefined;
    }
  }
}
