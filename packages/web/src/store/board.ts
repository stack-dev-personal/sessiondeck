import type { Envelope, SessionSnapshot } from "@sessiondeck/contract";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { applyEnvelope } from "../ingest";
import { exceeds200kOf } from "../statusline-adapter";
import { recordEnvelope, type SessionHistory } from "./history";

export type ConnectionStatus = "mock" | "connecting" | "open" | "closed";

export interface BoardState {
  sessions: Record<string, SessionSnapshot>;
  /**
   * exceeds_200k_tokens per session from the last statusLine payload. Web-side only: the contract
   * snapshot has no field for it (deferred to the contract owner). Missing key means unknown.
   */
  exceeds200k: Record<string, boolean | null>;
  /** Bounded per-session history for the detail drawer; fed by the same flush as snapshots. */
  history: Record<string, SessionHistory>;
  connection: ConnectionStatus;
  /** Epoch ms of the next reconnect attempt while closed; null otherwise. */
  retryAt: number | null;
  setConnection: (c: ConnectionStatus, retryAt?: number | null) => void;
  /** Queue an envelope; applied with every other queued update in the next animation frame. */
  enqueue: (e: Envelope) => void;
  /** Queue a hub snapshot delta; the latest per session_id wins within a frame. */
  enqueueSnapshot: (s: SessionSnapshot) => void;
  /** Replace the whole set (initial resync). Immediate. */
  replaceAll: (list: SessionSnapshot[]) => void;
  /** Apply everything queued now (also what the animation frame calls). */
  flush: () => void;
}

type Raf = (cb: () => void) => unknown;

/**
 * Sessions keyed by session_id. Updates arrive 5-20 per second; enqueue() collects them and one
 * set() per animation frame applies the batch, so subscribers render at most once per frame.
 * The raf is injectable for tests.
 */
export function createBoardStore(raf?: Raf): UseBoundStore<StoreApi<BoardState>> {
  const schedule: Raf = raf ?? ((cb) => requestAnimationFrame(cb));
  let queue: Envelope[] = [];
  let snaps = new Map<string, SessionSnapshot>();
  let scheduled = false;
  const arm = (flush: () => void) => {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  };
  return create<BoardState>()((set, get) => ({
    sessions: {},
    exceeds200k: {},
    history: {},
    connection: "closed",
    retryAt: null,
    setConnection: (connection, retryAt = null) => set({ connection, retryAt }),
    enqueue: (e) => {
      queue.push(e);
      arm(() => get().flush());
    },
    enqueueSnapshot: (s) => {
      snaps.set(s.session_id, s);
      arm(() => get().flush());
    },
    replaceAll: (list) => {
      queue = [];
      snaps = new Map();
      set({
        sessions: Object.fromEntries(list.map((s) => [s.session_id, s])),
        exceeds200k: {},
        history: {},
      });
    },
    flush: () => {
      scheduled = false;
      if (queue.length === 0 && snaps.size === 0) return;
      const batch = queue;
      const deltas = snaps;
      queue = [];
      snaps = new Map();
      const next = { ...get().sessions };
      let flags = get().exceeds200k;
      const history = { ...get().history };
      for (const e of batch) {
        if (e.session_id === null) continue;
        const before = next[e.session_id];
        const updated = applyEnvelope(before, e);
        if (updated) {
          next[e.session_id] = updated;
          history[e.session_id] = recordEnvelope(history[e.session_id], before, updated, e);
        }
        if (e.kind === "statusline") {
          const f = exceeds200kOf(e.payload);
          if (flags[e.session_id] !== f) flags = { ...flags, [e.session_id]: f };
        }
      }
      for (const [id, snap] of deltas) next[id] = snap;
      set({ sessions: next, exceeds200k: flags, history });
    },
  }));
}

export const useBoard = createBoardStore();

/** Hosts derived from the snapshots, sorted. */
export function selectHosts(sessions: Record<string, SessionSnapshot>): string[] {
  return [...new Set(Object.values(sessions).map((s) => s.host))].sort();
}
