import type { Envelope, SessionSnapshot } from "@sessiondeck/contract";
import { createSnapshot, reduce, reduceLiveness } from "@sessiondeck/contract";
import { applyStatusLine } from "./statusline-adapter";

/**
 * Applies one envelope to the snapshot for its session (undefined creates it). Envelope kinds the
 * board does not use yet return the snapshot with only last_event_at moved. Never throws on the
 * kinds it handles; the contract reducers are total.
 */
export function applyEnvelope(
  prev: SessionSnapshot | undefined,
  e: Envelope,
): SessionSnapshot | undefined {
  if (e.session_id === null) return prev;
  const base =
    prev ??
    createSnapshot({
      session_id: e.session_id,
      host: e.host,
      cwd: cwdOf(e.payload),
      ts: e.ts,
    });
  switch (e.kind) {
    case "hook":
      return reduce(base, e as Envelope<"hook">);
    case "liveness":
      return reduceLiveness(base, e as Envelope<"liveness">);
    case "statusline":
      return applyStatusLine(base, e.payload, e.ts);
    default:
      return { ...base, last_event_at: e.ts };
  }
}

function cwdOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "cwd" in payload) {
    const cwd = (payload as { cwd: unknown }).cwd;
    if (typeof cwd === "string") return cwd;
  }
  return "";
}
