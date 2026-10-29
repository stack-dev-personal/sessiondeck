// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDisplayActivity } from "./useDisplayActivity";

const T0 = 5_000_000;
const snap = (id: string, state: SessionState, at = T0): SessionSnapshot =>
  ({
    ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: 1 }),
    state,
    state_since: at,
    last_event_at: at,
  }) as SessionSnapshot;

describe("useDisplayActivity timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-arms when the timer fires while the clock is still short of the deadline", () => {
    let calls = 0;
    let wall = T0;
    // First read inside the effect after the fire reports a time before the deadline.
    const clock = () => {
      calls++;
      return wall;
    };
    const a = [snap("a", "working")];
    const b = [snap("a", "idle", T0)];
    const { result, rerender } = renderHook(({ s }) => useDisplayActivity(s, 10, clock), {
      initialProps: { s: a },
    });
    rerender({ s: b });
    expect(result.current[0]?.session.state).toBe("working");
    // Wall clock stepped back: the timer fires but clock() is still below the deadline.
    act(() => void vi.advanceTimersByTime(11_000));
    expect(result.current[0]?.session.state).toBe("working");
    wall = T0 + 10_001;
    act(() => void vi.advanceTimersByTime(10_002));
    expect(result.current[0]?.session.state).toBe("idle");
    expect(calls).toBeGreaterThan(0);
  });
});
