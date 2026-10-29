import type { SessionSnapshot, Window } from "@sessiondeck/contract";
import { useMemo } from "react";
import { useBoard } from "../store/board";

export type RateLimits = SessionSnapshot["rate_limits"];

/**
 * Account-wide usage is the same for every session of one account. Each window is decided on its
 * own: the freshest non-null value (by its payload's captured_at) wins, so a newer payload that
 * lacks one window does not hide an older payload's value. Only five_hour and seven_day (R3.12).
 */
export function pickFreshestWindow(
  sessions: Record<string, SessionSnapshot>,
  key: "five_hour" | "seven_day",
): { win: Window; at: number | null } | null {
  let best: { win: Window; at: number | null } | null = null;
  for (const s of Object.values(sessions)) {
    const w = s.rate_limits[key];
    if (w === null) continue;
    const at = s.rate_limits.captured_at;
    if (best === null || (at ?? -Infinity) > (best.at ?? -Infinity)) best = { win: w, at };
  }
  return best;
}

export function pickFreshestRateLimits(
  sessions: Record<string, SessionSnapshot>,
): RateLimits | null {
  const f = pickFreshestWindow(sessions, "five_hour");
  const d = pickFreshestWindow(sessions, "seven_day");
  if (f === null && d === null) return null;
  return {
    five_hour: f?.win ?? null,
    seven_day: d?.win ?? null,
    captured_at: Math.max(f?.at ?? -Infinity, d?.at ?? -Infinity) || null,
  };
}

export interface AccountUsage {
  five_hour: Window | null;
  seven_day: Window | null;
  captured_at: number | null;
}

/**
 * Self-contained data hook for the UsageWidget (S15 can host the widget in its own window with
 * this alone). Each selector returns an existing window object, stable until a newer payload
 * lands, so the widget does not re-render on unrelated session updates.
 */
export function useAccountUsage(): AccountUsage | null {
  const five = useBoard((s) => pickFreshestWindow(s.sessions, "five_hour")?.win ?? null);
  const seven = useBoard((s) => pickFreshestWindow(s.sessions, "seven_day")?.win ?? null);
  return useMemo(
    () =>
      five === null && seven === null
        ? null
        : { five_hour: five, seven_day: seven, captured_at: null },
    [five, seven],
  );
}
