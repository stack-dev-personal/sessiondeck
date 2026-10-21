import type { Envelope } from "@sessiondeck/contract";

export interface PlayOptions {
  /** Envelopes delivered per tick. */
  batch?: number;
  tickMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onDone?: () => void;
}

/**
 * Delivers the timeline paced (default 4 envelopes every 250 ms, about 16 per second like a tool
 * burst), then stops with the board settled. Returns a cancel function.
 */
export function playTimeline(
  timeline: readonly Envelope[],
  deliver: (e: Envelope) => void,
  opts: PlayOptions = {},
): () => void {
  const { batch = 4, tickMs = 250, onDone } = opts;
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let i = 0;
  let handle: unknown;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const end = Math.min(i + batch, timeline.length);
    for (; i < end; i++) deliver(timeline[i]!);
    if (i < timeline.length) handle = setT(tick, tickMs);
    else onDone?.();
  };
  tick();
  return () => {
    cancelled = true;
    clearT(handle);
  };
}
