import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildEnvelope, hookEnvelopeFromPayload } from "./envelope.ts";
import { hookErrorsLog, spoolDir } from "./paths.ts";
import { appendEnvelopes, type EnvelopeFactory } from "./spool.ts";
import type { StdinResult } from "./stdin.ts";

export const ERROR_LOG_MAX_BYTES = 64 * 1024;

export type HookOutcome = { ok: true; lines: number } | { ok: false; reason: string };

/** One short line, no payload content. Size-capped: past the cap the log restarts. */
export function logHookError(reason: string, logPath: string = hookErrorsLog()): void {
  try {
    const line = `${new Date().toISOString()} ${reason}\n`;
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      mkdirSync(dirname(logPath), { recursive: true });
    }
    if (size > ERROR_LOG_MAX_BYTES) writeFileSync(logPath, line);
    else appendFileSync(logPath, line);
  } catch {
    // Nowhere to report to; the hook must still exit 0.
  }
}

/** Turns raw stdin into spool lines. Returns the outcome; never throws. */
export function processHookInput(input: StdinResult, dir: string = spoolDir()): HookOutcome {
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
    if (hookEnvelopeFromPayload(payload, 0) === null) {
      return { ok: false, reason: "missing-session-id-or-event-name" };
    }
    const factories: EnvelopeFactory[] = [
      (seq) => {
        const env = hookEnvelopeFromPayload(payload, seq);
        if (!env) throw new Error("unreachable");
        return env;
      },
    ];
    if (payload["hook_event_name"] === "SessionStart") {
      // The exec-form hook's parent is claude itself.
      factories.push((seq) =>
        buildEnvelope({
          kind: "liveness",
          seq,
          payload: { pid: process.ppid, alive: true },
          session_id: payload["session_id"] as string,
        }),
      );
    }
    const res = appendEnvelopes(dir, factories);
    return { ok: true, lines: res.lines };
  } catch (e) {
    return { ok: false, reason: `spool-error ${(e as NodeJS.ErrnoException)?.code ?? "unknown"}` };
  }
}
