import { buildEnvelope } from "../envelope.ts";
import { logHookError } from "../hook-core.ts";
import { appendSpoolLines } from "../spool-writer.ts";
import type { StdinResult } from "../stdin.ts";

export type Parsed = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string };

export function parseObjectInput(input: StdinResult): Parsed {
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
  return { ok: true, payload: parsed as Record<string, unknown> };
}

/**
 * Appends one envelope of `kind` for a parsed payload; logs the reason on any failure. Never throws.
 * Returns the parse result so the caller can render from it.
 */
export function recordPayload(
  kind: "statusline" | "subagents",
  input: StdinResult,
  ctx: { spool: string; host: string; errorLog: string },
): Parsed {
  let res: Parsed;
  try {
    res = parseObjectInput(input);
  } catch {
    res = { ok: false, reason: "parse-error" };
  }
  try {
    if (!res.ok) {
      logHookError(`${kind} ${res.reason}`, ctx.errorLog);
      return res;
    }
    const sid = res.payload["session_id"];
    const session_id = typeof sid === "string" && sid !== "" && sid.length <= 256 ? sid : null;
    const out = appendSpoolLines(ctx.spool, [
      buildEnvelope({ kind, host: ctx.host, payload: res.payload, session_id }),
    ]);
    if (out.written === 0) logHookError(`${kind} line-too-large`, ctx.errorLog);
  } catch (e) {
    logHookError(
      `${kind} spool-error ${(e as NodeJS.ErrnoException)?.code ?? "unknown"}`,
      ctx.errorLog,
    );
  }
  return res;
}
