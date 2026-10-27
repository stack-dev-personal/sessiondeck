import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_CAP, type ActivityRow } from "../../store/activity";
import { ActivityList, OVERSCAN, windowOf } from "./ActivityList";

const rows = (from: number, to: number): ActivityRow[] =>
  Array.from({ length: to - from }, (_, i) => ({
    n: from + i,
    ts: 1_000,
    kind: "event" as const,
    glyph: "·",
    text: `row ${from + i}`,
  }));

const ROW_H = 24;
const VIEW_H = 240; // 10 rows

/** jsdom has no layout: give the scroller a height and let scrollHeight follow its content. */
let scrollTops = new WeakMap<Element, number>();
beforeEach(() => {
  scrollTops = new WeakMap();
  const proto = HTMLElement.prototype;
  vi.spyOn(proto, "clientHeight", "get").mockReturnValue(VIEW_H);
  vi.spyOn(proto, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.getAttribute("data-total") ?? 0) * ROW_H;
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      scrollTops.set(this, v);
    },
  });
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    getPropertyValue: () => `${ROW_H}px`,
  } as unknown as CSSStyleDeclaration);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)["scrollTop"];
});

const mounted = () => screen.queryAllByRole("listitem");
const log = () => screen.getByRole("log");

describe("windowOf (R6.4)", () => {
  it("is the viewport plus overscan, clamped to the list", () => {
    expect(windowOf(500, 24, 0, 240)).toEqual({ start: 0, end: 10 + OVERSCAN });
    expect(windowOf(500, 24, 2400, 240)).toEqual({ start: 100 - OVERSCAN, end: 110 + OVERSCAN });
    expect(windowOf(500, 24, 99999, 240)).toEqual({ start: 500, end: 500 });
  });
});

describe("ActivityList windowing (R6.4)", () => {
  it("mounts only the visible rows plus overscan for 500 rows", () => {
    render(<ActivityList rows={rows(0, ACTIVITY_CAP)} />);
    expect(log()).toHaveAttribute("data-total", "500");
    // Pinned: the last 10 rows are in view, plus overscan above (none below the end).
    expect(mounted().length).toBe(10 + OVERSCAN);
    expect(mounted().length).toBeLessThan(40);
    expect(screen.getByText("row 499")).toBeInTheDocument();
    expect(screen.queryByText("row 0")).toBeNull();
  });

  it("scrolling re-windows to the rows under the viewport", () => {
    render(<ActivityList rows={rows(0, ACTIVITY_CAP)} />);
    scrollTops.set(log(), 100 * ROW_H);
    fireEvent.scroll(log());
    expect(screen.getByText("row 100")).toBeInTheDocument();
    expect(screen.getByText("row 109")).toBeInTheDocument();
    expect(screen.queryByText("row 499")).toBeNull();
    expect(mounted().length).toBeLessThanOrEqual(10 + 2 * OVERSCAN);
  });
});

describe("ActivityList pinning (R6.4)", () => {
  it("follows new rows while pinned, stops when the user scrolls up, resumes on Jump to latest", () => {
    const { rerender } = render(<ActivityList rows={rows(0, 50)} />);
    expect(log().scrollTop).toBe((50 - 10) * ROW_H);
    expect(screen.getByTestId("activity-list")).toHaveAttribute("data-pinned", "true");

    rerender(<ActivityList rows={rows(0, 60)} />);
    expect(log().scrollTop).toBe((60 - 10) * ROW_H);
    expect(screen.getByText("row 59")).toBeInTheDocument();

    // The user scrolls up.
    scrollTops.set(log(), 10 * ROW_H);
    fireEvent.scroll(log());
    expect(screen.getByTestId("activity-list")).toHaveAttribute("data-pinned", "false");
    rerender(<ActivityList rows={rows(0, 70)} />);
    expect(log().scrollTop).toBe(10 * ROW_H);
    expect(screen.getByText("row 10")).toBeInTheDocument();
    expect(screen.queryByText("row 69")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(log().scrollTop).toBe((70 - 10) * ROW_H);
    expect(screen.getByTestId("activity-list")).toHaveAttribute("data-pinned", "true");
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  });

  it("End pins again, Home goes to the top (keyboard)", () => {
    render(<ActivityList rows={rows(0, 100)} />);
    scrollTops.set(log(), 5 * ROW_H);
    fireEvent.scroll(log());
    expect(screen.getByTestId("activity-list")).toHaveAttribute("data-pinned", "false");
    fireEvent.keyDown(log(), { key: "End" });
    expect(screen.getByTestId("activity-list")).toHaveAttribute("data-pinned", "true");
    expect(log().scrollTop).toBe(90 * ROW_H);
    fireEvent.keyDown(log(), { key: "Home" });
    expect(log().scrollTop).toBe(0);
  });

  it("keeps the reader's rows in view when the ring buffer drops old ones while unpinned", () => {
    const { rerender } = render(<ActivityList rows={rows(0, ACTIVITY_CAP)} />);
    scrollTops.set(log(), 200 * ROW_H);
    fireEvent.scroll(log());
    expect(screen.getByText("row 200")).toBeInTheDocument();
    // 30 rows appended, the oldest 30 dropped: row 200 now sits 30 rows higher.
    act(() => rerender(<ActivityList rows={rows(30, ACTIVITY_CAP + 30)} />));
    expect(log().scrollTop).toBe(170 * ROW_H);
    expect(screen.getByText("row 200")).toBeInTheDocument();
  });
});
