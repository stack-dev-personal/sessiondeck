/*
 * supersedeSamePid ports the behavior of MartinWickman/ccmonitor
 *   internal/hook/hook.go (cleanupSamePID) and internal/session/session.go
 *   @ 88f7d1adfbff82a790fbb37346cc70d276548f5c (MIT, Copyright (c) 2026 Martin Wickman)
 * Changes: instead of deleting session files, other non-terminal sessions on the same host and
 *   pid are returned as `ended` with ended_reason 'superseded'. Same-OS check becomes same-host
 *   check; pid <= 0 is ignored as in the source. findParentPID is the probe's job (Phase 1).
 *   The source runs cleanupSamePID on every event because events can continue under the old id
 *   after --continue/--resume; here a superseded session is revived by any later hook for it
 *   (ended_superseded row state), so an early or wrong supersede can be undone.
 *
 * The event-to-state mapping lives in transitions.ts (ccmon, cctop borrowings).
 */
import type { Envelope } from "./envelope";
import { applyEventFields } from "./event-fields";
import { LivenessPayloadSchema } from "./liveness";
import { agentIdOf, asRecord } from "./payload";
import type { SessionSnapshot } from "./snapshot";
import type { HookEventName } from "./state-names";
import { HOOK_EVENTS, SUPERSEDED_REASON } from "./state-names";
import { nextTracking, withReadTracking } from "./tracking";
import type { Transition, TransitionContext } from "./transitions";
import { resolveDetail, selectTransition } from "./transitions";

export { HOOK_EVENTS, ROW_STATES, SESSION_STATES, SUPERSEDED_REASON } from "./state-names";
export type { HookEventName, RowState, SessionState } from "./state-names";
export {
  LAST_MESSAGE_MAX_CHARS,
  LAST_PROMPT_MAX_CHARS,
  STATE_DETAIL_MAX_CHARS,
  TOOL_NAME_MAX_CHARS,
  TRUNCATION_MARKER,
} from "./limits";
export { TRANSITIONS, PROVISIONAL_BEHAVIOR } from "./transitions";
export type { Transition } from "./transitions";

function isHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

/**
 * Moves to the row's target state. state_since changes only when the state changes; tracking is
 * updated from the row; ended_reason survives only when the target is `ended`.
 */
function applyTransition(
  s: SessionSnapshot,
  t: Transition,
  ctx: TransitionContext,
  ts: number,
): SessionSnapshot {
  const next = nextTracking(t, ctx);
  return {
    ...s,
    state: t.to,
    state_since: t.to === s.state ? s.state_since : ts,
    state_detail: resolveDetail(t, ctx),
    ended_reason: t.to === "ended" ? s.ended_reason : null,
    tracking: next,
  };
}

/** Routing precondition: an envelope for another session or host never touches this snapshot. */
function isForSession(prev: SessionSnapshot, e: Envelope): boolean {
  return e.session_id === prev.session_id && e.host === prev.host;
}

/**
 * Pure and total: any (snapshot, hook envelope) pair gives a new snapshot, never throws, never
 * mutates its inputs. A snapshot stored without (or with a malformed) tracking counts as having
 * empty tracking, and the result always carries a well-formed one (same for reduceLiveness and
 * supersedeSamePid). Time comes only from e.ts. Unknown events only update last_event_at; a
 * malformed payload is read as empty, so its row still fires with default text. An envelope whose
 * session_id or host differs from the snapshot's returns `prev` itself, unchanged. A normal `ended` session with no matching row only updates
 * last_event_at. Nested objects of the result may be shared with `prev` (structural sharing).
 */
export function reduce(prevRaw: SessionSnapshot, e: Envelope<"hook">): SessionSnapshot {
  if (!isForSession(prevRaw, e)) return prevRaw;
  const prev = withReadTracking(prevRaw);
  const name = e.hook_event_name ?? "";
  const touched: SessionSnapshot = { ...prev, last_event_at: e.ts };
  const payload = asRecord(e.payload);
  const ctx: TransitionContext = { prev, agentId: agentIdOf(e), payload };
  const t = isHookEvent(name) ? selectTransition(name, ctx) : undefined;
  if (prev.state === "ended" && t === undefined) return touched;
  const fielded = applyEventFields(touched, name, e, payload);
  return t === undefined ? fielded : applyTransition(fielded, t, ctx, e.ts);
}

/**
 * alive: true records the pid; alive: false moves a live session to exited (no change when already
 * ended or exited, or when the report is for a pid other than the one on record). A payload that
 * does not match LivenessPayloadSchema only updates last_event_at. Another session or host: `prev`.
 */
export function reduceLiveness(prevRaw: SessionSnapshot, e: Envelope<"liveness">): SessionSnapshot {
  if (!isForSession(prevRaw, e)) return prevRaw;
  const prev = withReadTracking(prevRaw);
  const touched: SessionSnapshot = { ...prev, last_event_at: e.ts };
  const parsed = LivenessPayloadSchema.safeParse(e.payload);
  if (!parsed.success) return touched;
  if (parsed.data.alive) return { ...touched, pid: parsed.data.pid };
  if (prev.pid !== null && prev.pid !== parsed.data.pid) return touched;
  const ctx: TransitionContext = { prev, agentId: null, payload: asRecord(e.payload) };
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
    const prev = withReadTracking(s);
    const ctx: TransitionContext = { prev, agentId: null, payload: asRecord(null) };
    const t = selectTransition("superseded", ctx);
    if (t === undefined) return s;
    return { ...applyTransition(prev, t, ctx, incoming.ts), ended_reason: SUPERSEDED_REASON };
  });
}
