import type { StoreApi, UseBoundStore } from "zustand";
import type { BoardState } from "../store/board";
import type { Settings } from "../store/ui";
import { createAttentionDetector, type SeenEpisode } from "./detect";
import {
  browserEnv,
  playTone,
  showNotification,
  type AlertEnv,
  type ShownNotification,
} from "./deliver";

export const SEEN_KEY = "sd.alerts.seen";

function loadSeen(): Record<string, SeenEpisode> | undefined {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY);
    if (raw === null) return undefined;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return undefined;
    const out: Record<string, SeenEpisode> = {};
    for (const [id, e] of Object.entries(v)) {
      const r = e as Partial<SeenEpisode> | null;
      if (
        r &&
        (r.state === "waiting_permission" || r.state === "waiting_input") &&
        typeof r.since === "number"
      )
        out[id] = { state: r.state, since: r.since };
    }
    return out;
  } catch {
    return undefined;
  }
}

function saveSeen(seen: Record<string, SeenEpisode>): void {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* storage unavailable: repeats after a reload are acceptable */
  }
}

/**
 * Watches the board store and delivers one browser notification and/or one tone per episode
 * of an attention state. Delivery is gated live by the current Settings (opt-in, per-state
 * sound, global mute). The store coalesces to one set() per frame, so each call here sees one
 * batch. Seen episodes survive a reload in sessionStorage. A notification is closed when its
 * episode ends. Returns an unsubscribe function.
 */
export function startAlerts(
  board: UseBoundStore<StoreApi<BoardState>>,
  ui: UseBoundStore<StoreApi<{ settings: Settings }>>,
  env: AlertEnv = browserEnv(),
): () => void {
  const open = new Map<string, ShownNotification>();
  const closeFor = (id: string) => {
    const n = open.get(id);
    open.delete(id);
    try {
      n?.close();
    } catch {
      /* already gone */
    }
  };
  const detector = createAttentionDetector({
    seed: loadSeen(),
    onEnd: closeFor,
    // After a reload the page lost its handle on the notification it showed. Show it again with
    // the same tag (a silent replace, no tone) so the handle exists and it closes with the episode.
    onResume: (e) => {
      if (!ui.getState().settings.notifications) return;
      const n = showNotification(env, e);
      if (n) open.set(e.sessionId, n);
    },
  });
  let last = board.getState().sessions;
  // Baseline: sessions already present at start are recorded as seen episodes and reported once.
  const handle = (sessions: BoardState["sessions"]) => {
    const { settings } = ui.getState();
    const events = detector.observe(sessions);
    for (const e of events) {
      if (settings.notifications) {
        const n = showNotification(env, e);
        if (n) open.set(e.sessionId, n);
      }
      if (settings.sounds[e.state] && !settings.muted) playTone(env, e.state);
    }
    saveSeen(detector.entries());
  };
  handle(last);
  return board.subscribe((s) => {
    if (s.sessions === last) return;
    last = s.sessions;
    handle(s.sessions);
  });
}
