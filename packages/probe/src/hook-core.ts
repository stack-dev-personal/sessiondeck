import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { buildEnvelope, hookEnvelopeFromPayload } from "./envelope.ts";
import type { SpoolLine } from "./spool-format.ts";
import { appendSpoolLines, notRegular } from "./spool-writer.ts";
import type { StdinResult } from "./stdin.ts";

export const ERROR_LOG_MAX_BYTES = 64 * 1024;
/** session_id, hook_event_name and agent_id longer than this are rejected up front. */
export const MAX_ID_CHARS = 256;

export type HookOutcome = { ok: true; lines: number } | { ok: false; reason: string };

export interface HookContext {
  /** Spool directory. */
  spool: string;
  /** Host name stamped on every envelope (from --host, else os.hostname()). */
  host: string;
}

/**
 * One short line, no payload content. Size-capped: past the cap the log restarts. The file is
 * created 0600, never opened through a symlink, and a non-regular file is left alone.
 */
export function logHookError(reason: string, logPath: string): void {
  try {
    const line = `${new Date().toISOString()} ${reason}\n`;
    // O_NONBLOCK: a FIFO planted at the log name fails to open (ENXIO) instead of blocking the hook.
    const flags =
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0);
    const open = (): number => {
      if (constants.O_NOFOLLOW === undefined) {
        try {
          if (!lstatSync(logPath).isFile()) throw notRegular();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      return openSync(logPath, flags, 0o600);
    };
    let fd: number;
    try {
      fd = open();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      fd = open();
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return;
      if (st.size > ERROR_LOG_MAX_BYTES) ftruncateSync(fd, 0);
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Nowhere to report to; the hook must still exit 0.
  }
}

/** Turns raw stdin into spool lines. Returns the outcome; never throws. */
export function processHookInput(input: StdinResult, ctx: HookContext): HookOutcome {
  try {
    if (!input.ok) return { ok: false, reason: input.reason };
    if (input.data.length === 0) return { ok: false, reason: "empty-stdin" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8").decode(input.data));
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "not-an-object" };
    }
    const payload = parsed as Record<string, unknown>;
    const env = hookEnvelopeFromPayload(payload, ctx.host);
    if (env === null) return { ok: false, reason: "missing-session-id-or-event-name" };
    if (
      (env.session_id?.length ?? 0) > MAX_ID_CHARS ||
      (env.hook_event_name?.length ?? 0) > MAX_ID_CHARS ||
      (env.agent_id?.length ?? 0) > MAX_ID_CHARS
    ) {
      return { ok: false, reason: "id-too-long" };
    }
    const lines: SpoolLine[] = [env];
    if (env.hook_event_name === "SessionStart") {
      // The exec-form hook's parent is normally claude itself, but a node shim (Volta, a version
      // manager) can sit in between. The daemon (S2) must confirm this pid against
      // ~/.claude/sessions/*.json before trusting it.
      lines.push(
        buildEnvelope({
          kind: "liveness",
          host: ctx.host,
          payload: { pid: process.ppid, alive: true },
          session_id: env.session_id,
        }),
      );
    }
    const res = appendSpoolLines(ctx.spool, lines);
    if (res.dropped > 0 && res.written === 0) return { ok: false, reason: "line-too-large" };
    return { ok: true, lines: res.written };
  } catch (e) {
    return { ok: false, reason: `spool-error ${(e as NodeJS.ErrnoException)?.code ?? "unknown"}` };
  }
}
