import type { Envelope, SessionSnapshot } from "@sessiondeck/contract";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { applyEnvelope } from "../ingest";

export type ConnectionStatus = "mock" | "connecting" | "open" | "closed";

export interface BoardState {
  sessions: Record<string, SessionSnapshot>;
  connection: ConnectionStatus;
  setConnection: (c: ConnectionStatus) => void;
  /** Queue an envelope; applied with every other queued update in the next animation frame. */
  enqueue: (e: Envelope) => void;
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
  let scheduled = false;
  return create<BoardState>()((set, get) => ({
    sessions: {},
    connection: "closed",
    setConnection: (connection) => set({ connection }),
    enqueue: (e) => {
      queue.push(e);
      if (scheduled) return;
      scheduled = true;
      schedule(() => get().flush());
    },
    replaceAll: (list) => {
      queue = [];
      set({ sessions: Object.fromEntries(list.map((s) => [s.session_id, s])) });
    },
    flush: () => {
      scheduled = false;
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      const next = { ...get().sessions };
      for (const e of batch) {
        if (e.session_id === null) continue;
        const updated = applyEnvelope(next[e.session_id], e);
        if (updated) next[e.session_id] = updated;
      }
      set({ sessions: next });
    },
  }));
}

export const useBoard = createBoardStore();

/** Hosts derived from the snapshots, sorted. */
export function selectHosts(sessions: Record<string, SessionSnapshot>): string[] {
  return [...new Set(Object.values(sessions).map((s) => s.host))].sort();
}
