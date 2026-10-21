import type { Envelope, SessionSnapshot, SessionState } from "@sessiondeck/contract";

/** Fixed caps for the per-session ring buffers behind the detail drawer. */
export const HISTORY_CAPS = { transitions: 20, samples: 120, tail: 50 } as const;

export interface Transition {
  state: SessionState;
  detail: string | null;
  ts: number;
}

/** One statusLine context reading for the sparkline. */
export interface Sample {
  ts: number;
  pct: number;
}

export interface SessionHistory {
  /** Oldest first, at most HISTORY_CAPS.transitions. */
  transitions: Transition[];
  /** Oldest first, at most HISTORY_CAPS.samples. */
  samples: Sample[];
  /** Raw envelopes, oldest first, at most HISTORY_CAPS.tail. */
  tail: Envelope[];
}

export const EMPTY_HISTORY: SessionHistory = Object.freeze({
  transitions: [],
  samples: [],
  tail: [],
}) as SessionHistory;

/** Appends to a copy; when the copy would exceed `cap` the oldest entries drop. */
export function pushCapped<T>(list: readonly T[], item: T, cap: number): T[] {
  const next = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice();
  next.push(item);
  return next;
}

/**
 * History after one envelope was applied. `before` is the snapshot prior to the envelope (undefined
 * for the first event of a session), `after` the result. Never mutates `prev`.
 */
export function recordEnvelope(
  prev: SessionHistory | undefined,
  before: SessionSnapshot | undefined,
  after: SessionSnapshot,
  e: Envelope,
): SessionHistory {
  const h = prev ?? EMPTY_HISTORY;
  let transitions = h.transitions;
  if (before === undefined || before.state !== after.state) {
    transitions = pushCapped(
      transitions,
      { state: after.state, detail: after.state_detail, ts: e.ts },
      HISTORY_CAPS.transitions,
    );
  }
  let samples = h.samples;
  if (e.kind === "statusline" && after.context.used_pct !== null) {
    samples = pushCapped(samples, { ts: e.ts, pct: after.context.used_pct }, HISTORY_CAPS.samples);
  }
  return { transitions, samples, tail: pushCapped(h.tail, e, HISTORY_CAPS.tail) };
}
