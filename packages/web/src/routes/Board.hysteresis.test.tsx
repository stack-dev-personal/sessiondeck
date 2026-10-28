import { act, render, screen } from "@testing-library/react";
import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoard } from "../store/board";
import { useFilters } from "../store/filters";
import { DEFAULT_SETTINGS, useUi } from "../store/ui";
import { Board } from "./Board";

const T0 = Date.parse("2026-10-28T10:00:00Z");
const snap = (id: string, state: SessionState): SessionSnapshot =>
  ({
    ...createSnapshot({ session_id: id, host: "h1", cwd: `/w/${id}`, ts: 1 }),
    state,
    state_since: Date.now(),
    last_event_at: Date.now(),
  }) as SessionSnapshot;
const put = (list: SessionSnapshot[]) =>
  act(() =>
    useBoard.setState({ sessions: Object.fromEntries(list.map((s) => [s.session_id, s])) }),
  );
const groupOf = (id: string) =>
  document.querySelector(`[data-row="${id}"]`)?.getAttribute("data-group");
const cardState = (id: string) =>
  document
    .querySelector(`[data-row="${id}"] [data-testid="session-card"]`)
    ?.getAttribute("data-state");

describe("Board display activity (R3.10)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    window.localStorage.clear();
    useFilters.setState({ host: null, project: null });
    useUi.setState({ compact: false, selectedSessionId: null, settings: DEFAULT_SETTINGS });
    useBoard.setState({ sessions: {}, connection: "mock" });
  });
  afterEach(() => vi.useRealTimers());

  it("Stop then a prompt 30 s later never leaves the working group", () => {
    render(<Board />);
    put([snap("a", "working")]);
    put([snap("a", "idle")]);
    expect(groupOf("a")).toBe("working");
    expect(cardState("a")).toBe("working");
    act(() => void vi.advanceTimersByTime(30_000));
    expect(groupOf("a")).toBe("working");
    put([snap("a", "working")]);
    act(() => void vi.advanceTimersByTime(200_000));
    expect(groupOf("a")).toBe("working");
  });

  it("moves to idle once, 121 s after Stop, with no further delta", () => {
    render(<Board />);
    put([snap("a", "working")]);
    put([snap("a", "idle")]);
    act(() => void vi.advanceTimersByTime(119_000));
    expect(groupOf("a")).toBe("working");
    act(() => void vi.advanceTimersByTime(2_000));
    expect(groupOf("a")).toBe("idle");
    expect(cardState("a")).toBe("idle");
  });

  it("waiting shows at once and sorts first; grace 0 is raw", () => {
    render(<Board />);
    put([snap("a", "working"), snap("b", "working")]);
    put([snap("a", "working"), snap("b", "waiting_input")]);
    expect(groupOf("b")).toBe("attention");
    expect(screen.getAllByTestId("board-row")[0]?.getAttribute("data-row")).toBe("b");
    act(() => useUi.setState({ settings: { ...DEFAULT_SETTINGS, idleGraceSec: 0 } }));
    put([snap("a", "idle"), snap("b", "waiting_input")]);
    expect(groupOf("a")).toBe("idle");
  });
});
