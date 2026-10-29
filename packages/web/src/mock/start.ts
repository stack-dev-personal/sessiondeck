import type { BoardState } from "../store/board";
import type { StoreApi, UseBoundStore } from "zustand";
import { headlessSnapshot } from "./headless";
import { playTimeline } from "./player";
import { buildMockTimeline } from "./timeline";

/** `?replay=fast` delivers the whole timeline in a fraction of a second (e2e); default is paced. */
function paceFromUrl(): { batch: number; tickMs: number } | undefined {
  try {
    if (new URLSearchParams(window.location.search).get("replay") === "fast") {
      return { batch: 100, tickMs: 10 };
    }
  } catch {
    /* no location: default pace */
  }
  return undefined;
}

/**
 * `?headless=1` adds one headless session (transcript-sourced figures, R3.16) to the mock board.
 * Off by default so the standard 8-card board is unchanged.
 */
function headlessFromUrl(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("headless") === "1";
  } catch {
    return false;
  }
}

/**
 * Mock mode: no hub, no network. Replays contract fixtures through the store's reducers.
 * `<html data-replay>` is "running" while envelopes are delivered and "done" once the last one has
 * been flushed to the store (two frames after delivery, the store coalesces per frame).
 */
export function startMock(store: UseBoundStore<StoreApi<BoardState>>): () => void {
  const { setConnection, enqueue } = store.getState();
  const root = document.documentElement;
  setConnection("mock");
  root.dataset["replay"] = "running";
  const now = Date.now();
  if (headlessFromUrl()) store.getState().enqueueSnapshot(headlessSnapshot(now));
  return playTimeline(buildMockTimeline(now), enqueue, {
    ...paceFromUrl(),
    onDone: () => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          root.dataset["replay"] = "done";
        }),
      );
    },
  });
}
