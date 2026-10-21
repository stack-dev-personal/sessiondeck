import type { StoreApi, UseBoundStore } from "zustand";
import type { BoardState } from "../store/board";
import type { Settings } from "../store/ui";
import { createAttentionDetector, type AttentionEvent, type SeenEpisode } from "./detect";
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
        out[id] = { state: r.state, since: r.since, shown: r.shown === true };
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
  // Track whether the toast is still up: cleared when the user dismisses it, so a reload never
  // brings back a toast the user closed, or one that never announced.
  const track = (e: AttentionEvent, n: ShownNotification) => {
    open.set(e.sessionId, n);
    detector.markShown(e.sessionId, true);
    n.onclose = () => {
      if (open.get(e.sessionId) !== n) return;
      open.delete(e.sessionId);
      detector.markShown(e.sessionId, false);
      saveSeen(detector.entries());
    };
  };
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
    // After a reload the page lost its handle on a notification that was shown and not dismissed.
    // Replace it with the same tag (silent, no tone) so the handle exists and it closes with the
    // episode. Episodes that never announced, or were dismissed, are not resumed.
    onResume: (e) => {
      if (!ui.getState().settings.notifications) return;
      const n = showNotification(env, e);
      if (n) track(e, n);
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
        if (n) track(e, n);
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
