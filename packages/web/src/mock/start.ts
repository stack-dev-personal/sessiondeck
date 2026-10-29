import type { BoardState } from "../store/board";
import type { StoreApi, UseBoundStore } from "zustand";
import { playTimeline } from "./player";
import {
  buildMockTimeline,
  DEFAULT_FLAP_MS,
  flapEnvelope,
  linkMockSubagents,
  MOCK_DEEP_SESSION,
} from "./timeline";

/**
 * URL switches (all optional):
 *   usage=none  no statusLine carries rate_limits: the usage widget shows its empty state
 *   flap=<ms>   gap between the flapping session's Stop and prompt (default 30000; 0 turns it off;
 *               with replay=fast the default is off, so e2e baselines cannot drift)
 */
function paramsFromUrl(): { usage: boolean; flapMs: number } {
  try {
    const q = new URLSearchParams(window.location.search);
    const dflt = q.get("replay") === "fast" ? 0 : DEFAULT_FLAP_MS;
    const raw = q.get("flap");
    const flap = raw ? Number(raw) : dflt;
    return {
      usage: q.get("usage") !== "none",
      flapMs: Number.isFinite(flap) && flap >= 0 ? flap : dflt,
    };
  } catch {
    return { usage: true, flapMs: DEFAULT_FLAP_MS };
  }
}

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
 * Mock mode: no hub, no network. Replays contract fixtures through the store's reducers.
 * `<html data-replay>` is "running" while envelopes are delivered and "done" once the last one has
 * been flushed to the store (two frames after delivery, the store coalesces per frame).
 */
export function startMock(store: UseBoundStore<StoreApi<BoardState>>): () => void {
  const { setConnection, enqueue, enqueueSnapshot } = store.getState();
  const { usage, flapMs } = paramsFromUrl();
  const root = document.documentElement;
  setConnection("mock");
  root.dataset["replay"] = "running";
  let n = 0;
  let nextStop = true;
  let flapTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** Sends the next Stop or UserPromptSubmit of the flapping session. */
  const flap = (name?: "Stop" | "UserPromptSubmit") => {
    const which = name ?? (nextStop ? "Stop" : "UserPromptSubmit");
    nextStop = which !== "Stop";
    // +n keeps ts strictly increasing even when the clock is frozen (e2e), so the reducer applies it.
    n += 1;
    enqueue(flapEnvelope(which, Date.now() + n, n));
  };
  const schedule = () => {
    if (stopped || flapMs === 0) return;
    flapTimer = setTimeout(() => {
      flap();
      schedule();
    }, flapMs);
  };
  // e2e drives the same Stop/prompt by hand (mock builds only; this module is never loaded otherwise).
  (window as unknown as { __sdMock?: unknown }).__sdMock = { flap };
  const cancel = playTimeline(buildMockTimeline(Date.now(), { usage }), enqueue, {
    ...paceFromUrl(),
    onDone: () => {
      // Apply the queued tail first so the snapshot patch cannot drop an envelope.
      store.getState().flush();
      const deep = store.getState().sessions[MOCK_DEEP_SESSION];
      if (deep) enqueueSnapshot(linkMockSubagents(deep));
      schedule();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          root.dataset["replay"] = "done";
        }),
      );
    },
  });
  return () => {
    stopped = true;
    clearTimeout(flapTimer);
    cancel();
  };
}
