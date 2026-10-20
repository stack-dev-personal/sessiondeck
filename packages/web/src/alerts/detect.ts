import type { SessionSnapshot, SessionState } from "@sessiondeck/contract";
import { isAttentionState } from "../lib/attention";

export type AttentionState = Extract<SessionState, "waiting_permission" | "waiting_input">;

export interface AttentionEvent {
  sessionId: string;
  state: AttentionState;
  session: SessionSnapshot;
}

/**
 * Detects transitions INTO waiting_permission or waiting_input from consecutive store states.
 *
 * Episode rule: an episode is one unbroken stay in one attention state. It is recorded the first
 * time the detector sees it and ends when the session leaves that state (to anything, including
 * the other attention state, which starts a new episode) or disappears from the store.
 *
 * Resync rule: the live `initial` message replaces the whole set. A session that is waiting in
 * `initial` and was not yet seen waiting in that state counts as a transition and is reported
 * once (the user may have been away; this is the alert they would otherwise miss). A session
 * whose episode was already recorded is never reported again by a resync. Because the record is
 * kept across the resync, a reconnect cannot re-notify. A session absent from `initial` loses its
 * record, so a later return into waiting is a new episode.
 *
 * Recording does not depend on delivery: an episode seen while the user was opted out is still
 * recorded, so opting in later does not announce sessions that are already waiting.
 */
export interface SeenEpisode {
  state: AttentionState;
  since: number;
}

export interface DetectorOptions {
  /** Episodes recorded by an earlier page load (same tab). Pruned on the first non-empty set. */
  seed?: Record<string, SeenEpisode>;
  /** An episode ended: the session left the state or disappeared. */
  onEnd?: (sessionId: string) => void;
}

/**
 * An episode is keyed by (session_id, state, state_since); state_since only changes when the state
 * does, so a reload or a second observer with the same key is the same episode. With a seed, the
 * empty set before the first `initial` is ignored so the seeded records survive until real data.
 */
export function createAttentionDetector(opts: DetectorOptions = {}) {
  const seen = new Map<string, SeenEpisode>(Object.entries(opts.seed ?? {}));
  let primed = opts.seed === undefined || Object.keys(opts.seed).length === 0;
  const end = (id: string) => {
    seen.delete(id);
    opts.onEnd?.(id);
  };
  return {
    observe(sessions: Record<string, SessionSnapshot>): AttentionEvent[] {
      if (!primed) {
        if (Object.keys(sessions).length === 0) return [];
        primed = true;
      }
      const events: AttentionEvent[] = [];
      for (const id of [...seen.keys()]) if (!(id in sessions)) end(id);
      for (const [id, session] of Object.entries(sessions)) {
        if (!isAttentionState(session.state)) {
          if (seen.has(id)) end(id);
          continue;
        }
        const state = session.state as AttentionState;
        const since = session.state_since;
        const prev = seen.get(id);
        if (prev && prev.state === state && prev.since === since) continue;
        if (prev) opts.onEnd?.(id);
        seen.set(id, { state, since });
        events.push({ sessionId: id, state, session });
      }
      return events;
    },
    /** Current records, for persistence. */
    entries(): Record<string, SeenEpisode> {
      return Object.fromEntries(seen);
    },
  };
}
