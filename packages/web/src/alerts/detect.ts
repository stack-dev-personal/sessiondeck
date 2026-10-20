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
export function createAttentionDetector() {
  const seen = new Map<string, AttentionState>();
  return {
    observe(sessions: Record<string, SessionSnapshot>): AttentionEvent[] {
      const events: AttentionEvent[] = [];
      for (const id of seen.keys()) if (!(id in sessions)) seen.delete(id);
      for (const [id, session] of Object.entries(sessions)) {
        if (!isAttentionState(session.state)) {
          seen.delete(id);
          continue;
        }
        const state = session.state as AttentionState;
        if (seen.get(id) === state) continue;
        seen.set(id, state);
        events.push({ sessionId: id, state, session });
      }
      return events;
    },
  };
}
