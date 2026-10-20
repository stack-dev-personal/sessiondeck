import type { StoreApi, UseBoundStore } from "zustand";
import type { BoardState } from "../store/board";
import type { Settings } from "../store/ui";
import { createAttentionDetector } from "./detect";
import { browserEnv, playTone, showNotification, type AlertEnv } from "./deliver";

/**
 * Watches the board store and delivers one browser notification and/or one tone per transition
 * into an attention state. Delivery is gated live by the current Settings (opt-in, per-state
 * sound, global mute). The store coalesces to one set() per frame, so each call here sees one
 * batch. Returns an unsubscribe function.
 */
export function startAlerts(
  board: UseBoundStore<StoreApi<BoardState>>,
  ui: UseBoundStore<StoreApi<{ settings: Settings }>>,
  env: AlertEnv = browserEnv(),
): () => void {
  const detector = createAttentionDetector();
  let last = board.getState().sessions;
  // Baseline: sessions already present at start are recorded as seen episodes and reported once.
  const handle = (sessions: BoardState["sessions"]) => {
    const { settings } = ui.getState();
    for (const e of detector.observe(sessions)) {
      if (settings.notifications) showNotification(env, e);
      if (settings.sounds[e.state] && !settings.muted) playTone(env, e.state);
    }
  };
  handle(last);
  return board.subscribe((s) => {
    if (s.sessions === last) return;
    last = s.sessions;
    handle(s.sessions);
  });
}
