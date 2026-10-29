import type { SessionSnapshot } from "@sessiondeck/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deriveDisplay,
  nextDeadline,
  sortDisplay,
  type DisplayGroup,
  type TrackedMap,
} from "../lib/display-activity";

export interface DisplayRow {
  /** The snapshot to render; state is "working" while an idle is held inside the grace. */
  session: SessionSnapshot;
  group: DisplayGroup;
}

/**
 * Sessions in stable display order with hysteresis applied. Re-evaluates when the input changes
 * and when the next held session reaches its deadline (one timer, no polling). `clock` is
 * injectable for tests.
 */
export function useDisplayActivity(
  sessions: readonly SessionSnapshot[],
  graceSec: number,
  clock: () => number = Date.now,
): DisplayRow[] {
  const [tick, setTick] = useState(0);
  const tracked = useRef<TrackedMap>(new Map());
  const shown = useRef(
    new Map<string, { raw: SessionSnapshot; state: string; out: SessionSnapshot }>(),
  );
  const graceMs = graceSec * 1000;
  const now = clock();
  const { rows, deadline } = useMemo(() => {
    void tick;
    const map = deriveDisplay(tracked.current, sessions, now, graceMs);
    tracked.current = map;
    const prevCache = shown.current;
    const cache = new Map<string, { raw: SessionSnapshot; state: string; out: SessionSnapshot }>();
    const out: DisplayRow[] = sortDisplay(sessions, map).map((raw) => {
      const t = map.get(raw.session_id)!;
      if (t.displayState === raw.state) return { session: raw, group: t.group };
      const hit = prevCache.get(raw.session_id);
      const session =
        hit && hit.raw === raw && hit.state === t.displayState
          ? hit.out
          : { ...raw, state: t.displayState, state_detail: null };
      cache.set(raw.session_id, { raw, state: t.displayState, out: session });
      return { session, group: t.group };
    });
    shown.current = cache;
    return { rows: out, deadline: nextDeadline(map, graceMs) };
    // `now` is read each render but only a changed input or the timer should recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, graceMs, tick]);
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, deadline - clock()) + 1);
    return () => window.clearTimeout(id);
  }, [deadline, clock, tick]);
  return rows;
}
