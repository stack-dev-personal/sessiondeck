/*
 * supersedeSamePid ports the behavior of MartinWickman/ccmonitor
 *   internal/hook/hook.go (cleanupSamePID) and internal/session/session.go
 *   @ 88f7d1adfbff82a790fbb37346cc70d276548f5c (MIT, Copyright (c) 2026 Martin Wickman)
 * Changes: instead of deleting session files, other non-terminal sessions on the same host and
 *   pid are returned as `ended` with ended_reason 'superseded'. Same-OS check becomes same-host
 *   check; pid <= 0 is ignored as in the source. findParentPID is the probe's job (Phase 1).
 *
 * The event-to-state mapping lives in transitions.ts (ccmon, cctop borrowings).
 */
import type { Envelope } from "./envelope";
import { applyEventFields } from "./event-fields";
import { LivenessPayloadSchema } from "./liveness";
import { asRecord, isSubagentEnvelope } from "./payload";
import type { SessionSnapshot } from "./snapshot";
import type { HookEventName } from "./state-names";
import { HOOK_EVENTS } from "./state-names";
import type { Transition, TransitionContext } from "./transitions";
import { resolveDetail, selectTransition } from "./transitions";

export { HOOK_EVENTS, SESSION_STATES } from "./state-names";
export type { HookEventName, SessionState } from "./state-names";
export { TRANSITIONS, PROVISIONAL_BEHAVIOR } from "./transitions";
export type { Transition } from "./transitions";

/** Reason recorded on a session ended because a newer session_id took over its pid. */
export const SUPERSEDED_REASON = "superseded";

function isHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

/** Moves to the row's target state. state_since changes only when the state changes. */
function applyTransition(
  s: SessionSnapshot,
  t: Transition,
  ctx: TransitionContext,
  ts: number,
): SessionSnapshot {
  return {
    ...s,
    state: t.to,
    state_since: t.to === s.state ? s.state_since : ts,
    state_detail: resolveDetail(t, ctx),
  };
}

/**
 * Pure and total: any (snapshot, hook envelope) pair gives a new snapshot, never throws, never
 * mutates its inputs. Time comes only from e.ts. Unknown events and malformed payloads only
 * update last_event_at. Nested objects of the result may be shared with `prev` (structural sharing).
 */
export function reduce(prev: SessionSnapshot, e: Envelope<"hook">): SessionSnapshot {
  const name = e.hook_event_name ?? "";
  const touched: SessionSnapshot = { ...prev, last_event_at: e.ts };
  if (prev.state === "ended" && name !== "SessionStart") return touched;
  const payload = asRecord(e.payload);
  const fielded = applyEventFields(touched, name, e, payload);
  const ctx: TransitionContext = { prev, subagent: isSubagentEnvelope(e), payload };
  const t = isHookEvent(name) ? selectTransition(name, ctx) : undefined;
  return t === undefined ? fielded : applyTransition(fielded, t, ctx, e.ts);
}

/**
 * alive: true records the pid; alive: false moves a live session to exited (no change when already
 * ended or exited). A payload that does not match LivenessPayloadSchema only updates last_event_at.
 */
export function reduceLiveness(prev: SessionSnapshot, e: Envelope<"liveness">): SessionSnapshot {
  const touched: SessionSnapshot = { ...prev, last_event_at: e.ts };
  const parsed = LivenessPayloadSchema.safeParse(e.payload);
  if (!parsed.success) return touched;
  if (parsed.data.alive) return { ...touched, pid: parsed.data.pid };
  const ctx: TransitionContext = { prev, subagent: false, payload: asRecord(e.payload) };
  const t = selectTransition("liveness_dead", ctx);
  return t === undefined ? touched : applyTransition(touched, t, ctx, e.ts);
}

export interface IncomingSession {
  host: string;
  session_id: string;
  pid: number;
  /** Epoch ms of the event that revealed the new session. */
  ts: number;
}

/**
 * A new session_id under the same pid (/clear, --resume) never gets a SessionEnd for the old one.
 * Returns the collection with every other non-terminal session on the same host and pid ended as
 * 'superseded'. Order is kept; untouched entries are the same objects. An invalid pid changes nothing.
 */
export function supersedeSamePid(
  sessions: readonly SessionSnapshot[],
  incoming: IncomingSession,
): SessionSnapshot[] {
  if (!Number.isInteger(incoming.pid) || incoming.pid <= 0) return [...sessions];
  return sessions.map((s) => {
    if (s.host !== incoming.host || s.pid !== incoming.pid) return s;
    if (s.session_id === incoming.session_id) return s;
    const ctx: TransitionContext = { prev: s, subagent: false, payload: asRecord(null) };
    const t = selectTransition("superseded", ctx);
    if (t === undefined) return s;
    return { ...applyTransition(s, t, ctx, incoming.ts), ended_reason: SUPERSEDED_REASON };
  });
}
