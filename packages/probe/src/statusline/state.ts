// Derives a one-word session state for the status bar from the tail of the local spool.
// No zod: the mapping mirrors the contract's TRANSITIONS table (a test compares them per event).
// Reads at most 64 KB of today's (UTC) day file, then yesterday's; any error gives "n/a".
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { dayFileName } from "../paths.ts";

export const NO_STATE = "n/a";
export const TAIL_BYTES = 64 * 1024;

const WAITING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);

/**
 * State after a main-thread hook event, from the contract's rows (first match from a live state).
 * null: the event does not change state (keep looking further back).
 */
export function stateForHook(event: string, payload: unknown, isSubagent: boolean): string | null {
  switch (event) {
    case "SessionStart":
      return (payload as { source?: unknown } | null)?.source === "compact" ? null : "starting";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
    case "PostCompact":
      // A subagent's tool events never leave idle or waiting_input, so they say nothing.
      return isSubagent ? null : "working";
    case "PermissionRequest":
      return "waiting_permission";
    case "Notification": {
      const t = (payload as { notification_type?: unknown } | null)?.notification_type;
      return typeof t === "string" && WAITING_NOTIFICATIONS.has(t) ? "waiting_permission" : null;
    }
    case "Stop":
      return isSubagent ? null : "idle";
    case "StopFailure":
      return "error";
    case "SessionEnd":
      return isSubagent ? null : "ended";
    default:
      return null;
  }
}

/** Last up-to-64 KB of a regular file (never through a symlink), whole lines only; null if absent. */
export function readTail(path: string, max = TAIL_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
    if (st.size > len) {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** State from the last matching hook line in `text` for this session, or null. */
export function stateFromTail(text: string, sessionId: string): string | null {
  const ls = text.split("\n");
  for (let i = ls.length - 1; i >= 0; i -= 1) {
    const l = ls[i] as string;
    if (l === "" || !l.includes('"hook"') || !l.includes(sessionId)) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o["kind"] !== "hook" || o["session_id"] !== sessionId) continue;
      const ev = o["hook_event_name"];
      if (typeof ev !== "string") continue;
      const s = stateForHook(ev, o["payload"], typeof o["agent_id"] === "string");
      if (s !== null) return s;
    } catch {
      continue;
    }
  }
  return null;
}

export function deriveState(spool: string, sessionId: unknown, now: number = Date.now()): string {
  try {
    if (typeof sessionId !== "string" || sessionId === "") return NO_STATE;
    for (const ts of [now, now - 86_400_000]) {
      const text = readTail(join(spool, dayFileName(ts)));
      if (text === null) continue;
      const s = stateFromTail(text, sessionId);
      if (s !== null) return s;
    }
  } catch {
    // fall through
  }
  return NO_STATE;
}
