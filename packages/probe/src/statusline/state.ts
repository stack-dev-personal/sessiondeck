// Derives a one-word session state for the status bar from the tail of the local spool.
// No zod: stepState() mirrors the contract's TRANSITIONS table and tracking (a test replays every
// pair of fixture events through the contract's reduce() and compares). Reads at most 64 KB of
// today's (UTC) day file, then yesterday's; any error gives "n/a".
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { dayFileName } from "../paths.ts";

export const NO_STATE = "n/a";
export const TAIL_BYTES = 64 * 1024;

const PERMISSION_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);
/** Notification may move to waiting_permission from these (waiting_input is left alone). */
const NOTIFY_FROM = new Set(["starting", "working", "idle", "error"]);
const OVER_INPUT = new Set(["idle", "waiting_input"]);
const ASK_USER_TOOL = "AskUserQuestion";
const EXIT_PLAN_TOOL = "ExitPlanMode";

/** Who holds an open permission prompt: an agent id (null: main thread) or unknown (undefined). */
type Holder = { agent: string | null } | "unknown";

/** The slice of the contract's snapshot the status bar needs. state null: not known yet. */
export interface Track {
  state: string | null;
  lastTool: string | null;
  permission: Holder | null;
}

export const UNKNOWN_TRACK: Track = { state: null, lastTool: null, permission: null };

const str = (o: unknown, k: string): string | null => {
  const v = o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : null;
};

/**
 * One hook event applied to what is known so far (a port of reduce() for the state field).
 * `agent` is the envelope's agent_id (null: main thread). With state null (the tail begins mid
 * session) events that need the prior state keep it unknown instead of guessing.
 */
export function stepState(t: Track, event: string, payload: unknown, agent: string | null): Track {
  const s = t.state;
  if (event === "SessionStart") {
    return str(payload, "source") === "compact"
      ? t
      : { state: "starting", lastTool: null, permission: null };
  }
  if (s === "ended") return t; // only a (non-compact) SessionStart leaves ended
  const permFree =
    s !== "waiting_permission" ||
    t.permission === null ||
    t.permission === "unknown" ||
    t.permission.agent === agent;
  const overInput = s !== null && OVER_INPUT.has(s);
  const to = (state: string, lastTool: string | null = t.lastTool): Track => ({
    state,
    lastTool,
    permission: null,
  });
  switch (event) {
    case "UserPromptSubmit":
      return to("working", null);
    case "PreToolUse":
      if (!permFree) return t;
      if (agent === null) return to("working", str(payload, "tool_name"));
      return s === null || overInput ? t : to("working");
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
      if (!permFree || (agent !== null && (s === null || overInput))) return t;
      return to("working");
    case "PermissionRequest":
      return {
        state: "waiting_permission",
        lastTool: t.lastTool,
        permission: { agent },
      };
    case "Notification": {
      const type = str(payload, "notification_type");
      if (type === null || !PERMISSION_NOTIFICATIONS.has(type)) return t;
      // Unknown prior state: a permission prompt is on screen, so waiting_permission is the best guess.
      if (s !== null && !NOTIFY_FROM.has(s)) return t;
      return {
        state: "waiting_permission",
        lastTool: t.lastTool,
        permission: agent === null ? "unknown" : { agent },
      };
    }
    case "Stop":
      if (agent !== null) return t;
      return to(
        t.lastTool === ASK_USER_TOOL || t.lastTool === EXIT_PLAN_TOOL ? "waiting_input" : "idle",
        null,
      );
    case "StopFailure":
      return to("error");
    case "PostCompact":
      // Only a session that is starting or working is (re)opened; otherwise the compaction is counted.
      return s === "starting" || s === "working" ? to("working") : t;
    case "SessionEnd":
      return agent === null ? to("ended") : t;
    default:
      return t;
  }
}

/** One main-thread or subagent hook line of a session, in file order. */
export interface HookEvent {
  event: string;
  payload: unknown;
  agent: string | null;
}

/** Replays events in order from `init`; the state is null when nothing decided it. */
export function replay(events: readonly HookEvent[], init: Track = UNKNOWN_TRACK): string | null {
  let t = init;
  for (const e of events) t = stepState(t, e.event, e.payload, e.agent);
  return t.state;
}

/** The session's hook lines in `text`, in order. Other sessions, other kinds and garbage are skipped. */
export function sessionEvents(text: string, sessionId: string): HookEvent[] {
  const out: HookEvent[] = [];
  for (const l of text.split("\n")) {
    if (l === "" || !l.includes('"hook"') || !l.includes(sessionId)) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o["kind"] !== "hook" || o["session_id"] !== sessionId) continue;
      const ev = o["hook_event_name"];
      if (typeof ev !== "string") continue;
      const agent = o["agent_id"];
      out.push({
        event: ev,
        payload: o["payload"],
        agent: typeof agent === "string" ? agent : null,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export interface Tail {
  text: string;
  /** True when the whole file was read (so nothing earlier exists in it). */
  whole: boolean;
}

/**
 * Last up-to-64 KB of a regular file, whole lines only; null if absent, not a regular file, a
 * symlink or unreadable. Never blocks: O_NONBLOCK keeps a FIFO from hanging open(), and where
 * O_NOFOLLOW does not exist (Windows) the file is lstat'ed first.
 */
export function readTailInfo(path: string, max = TAIL_BYTES): Tail | null {
  let fd: number;
  try {
    if (constants.O_NOFOLLOW === undefined && !lstatSync(path).isFile()) return null;
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, st.size - len + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString("utf8");
    const whole = st.size <= len;
    if (!whole) {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
    }
    return { text, whole };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function readTail(path: string, max = TAIL_BYTES): string | null {
  return readTailInfo(path, max)?.text ?? null;
}

/** State from the session's lines in `text` (replayed in order), or null. */
export function stateFromTail(text: string, sessionId: string): string | null {
  return replay(sessionEvents(text, sessionId));
}

export function deriveState(spool: string, sessionId: unknown, now: number = Date.now()): string {
  try {
    if (typeof sessionId !== "string" || sessionId === "") return NO_STATE;
    const today = readTailInfo(join(spool, dayFileName(now)));
    const events = today ? sessionEvents(today.text, sessionId) : [];
    // A file larger than the tail has earlier lines of today that we did not see, so yesterday is
    // not the next thing back: replay today alone. Otherwise (absent or read whole) today starts
    // from yesterday's state, because a Stop or similar line alone is a guess without it.
    if (today && !today.whole) return replay(events) ?? NO_STATE;
    const y = readTailInfo(join(spool, dayFileName(now - 86_400_000)));
    if (!y) return replay(events) ?? NO_STATE;
    return replay([...sessionEvents(y.text, sessionId), ...events]) ?? NO_STATE;
  } catch {
    return NO_STATE;
  }
}
