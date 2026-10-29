import type { SessionSnapshot, Window } from "@sessiondeck/contract";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
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
    captured_at: larger(f?.at ?? null, d?.at ?? null),
  };
}

/** The larger of two optional values; null only when neither exists (0 is a value). */
function larger(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export interface AccountUsage {
  five_hour: Window | null;
  seven_day: Window | null;
  captured_at: number | null;
}

interface Flat {
  fu: number | null;
  fr: number | null;
  fa: number | null;
  su: number | null;
  sr: number | null;
  sa: number | null;
  hasFive: boolean;
  hasSeven: boolean;
}

/** Primitives only, so shallow equality compares used_pct and resets_at, never object identity. */
function selectFlat(sessions: Record<string, SessionSnapshot>): Flat {
  const f = pickFreshestWindow(sessions, "five_hour");
  const d = pickFreshestWindow(sessions, "seven_day");
  return {
    fu: f?.win.used_pct ?? null,
    fr: f?.win.resets_at ?? null,
    fa: f?.at ?? null,
    su: d?.win.used_pct ?? null,
    sr: d?.win.resets_at ?? null,
    sa: d?.at ?? null,
    hasFive: f !== null,
    hasSeven: d !== null,
  };
}

/**
 * Self-contained data hook for the UsageWidget (S15 can host the widget in its own window with
 * this alone). The store replaces whole snapshots, so the selection is compared by value
 * (used_pct, resets_at, captured_at): the result keeps its identity, and the widget does not
 * re-render, until one of those changes.
 */
export function useAccountUsage(): AccountUsage | null {
  const x = useBoard(useShallow((s) => selectFlat(s.sessions)));
  const five = useMemo(
    () => (x.hasFive ? { used_pct: x.fu, resets_at: x.fr } : null),
    [x.hasFive, x.fu, x.fr],
  );
  const seven = useMemo(
    () => (x.hasSeven ? { used_pct: x.su, resets_at: x.sr } : null),
    [x.hasSeven, x.su, x.sr],
  );
  const at = larger(x.hasFive ? x.fa : null, x.hasSeven ? x.sa : null);
  return useMemo(
    () =>
      five === null && seven === null
        ? null
        : { five_hour: five, seven_day: seven, captured_at: at },
    [five, seven, at],
  );
}
