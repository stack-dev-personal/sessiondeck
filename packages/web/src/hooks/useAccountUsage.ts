import type { SessionSnapshot, Window } from "@sessiondeck/contract";
import { useBoard } from "../store/board";

export type RateLimits = SessionSnapshot["rate_limits"];

/**
 * Account-wide usage is the same for every session of one account, so the freshest statusLine
 * rate_limits payload across sessions wins. Only five_hour and seven_day, as reported (R3.12).
 * Returns null when no session has reported a window.
 */
export function pickFreshestRateLimits(
  sessions: Record<string, SessionSnapshot>,
): RateLimits | null {
  let best: RateLimits | null = null;
  for (const s of Object.values(sessions)) {
    const rl = s.rate_limits;
    if (rl.five_hour === null && rl.seven_day === null) continue;
    if (best === null || (rl.captured_at ?? -Infinity) > (best.captured_at ?? -Infinity)) best = rl;
  }
  return best;
}

export interface AccountUsage {
  five_hour: Window | null;
  seven_day: Window | null;
  captured_at: number | null;
}

/**
 * Self-contained data hook for the UsageWidget (S15 can host the widget in its own window with
 * this alone). The selector returns the winning rate_limits object, which is stable until a
 * newer payload lands, so the widget does not re-render on unrelated session updates.
 */
export function useAccountUsage(): AccountUsage | null {
  return useBoard((s) => pickFreshestRateLimits(s.sessions));
}
