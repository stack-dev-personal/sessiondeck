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

/** scrollTop (negative, column-reverse) that puts row index `first` at the top of the view. */
const scrollTopFor = (count: number, first: number) => -(count * ROW_H - VIEW_H - first * ROW_H);

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
    scrollTops.set(log(), scrollTopFor(500, 100));
    fireEvent.scroll(log());
    expect(screen.getByText("row 100")).toBeInTheDocument();
    expect(screen.getByText("row 109")).toBeInTheDocument();
    expect(screen.queryByText("row 499")).toBeNull();
    expect(mounted().length).toBeLessThanOrEqual(10 + 2 * OVERSCAN);
  });

  it("pinned, the list never writes the scroll position (no forced layout per row)", () => {
    const writes = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: writes,
    });
    const { rerender } = render(<ActivityList rows={rows(0, 50)} />);
    for (let n = 51; n < 120; n++) rerender(<ActivityList rows={rows(0, n)} />);
    expect(writes).not.toHaveBeenCalled();
    expect(screen.getByText("row 118")).toBeInTheDocument();
  });
});

describe("ActivityList pinning (R6.4)", () => {
  const pinned = () => screen.getByTestId("activity-list").getAttribute("data-pinned");

  it("follows new rows while pinned, stops when the user scrolls up, resumes on Jump to latest", () => {
    const { rerender } = render(<ActivityList rows={rows(0, 50)} />);
    expect(pinned()).toBe("true");
    expect(screen.getByText("row 49")).toBeInTheDocument();

    rerender(<ActivityList rows={rows(0, 60)} />);
    expect(log().scrollTop).toBe(0);
    expect(screen.getByText("row 59")).toBeInTheDocument();

    // The user scrolls up so that row 10 is the first one in view.
    scrollTops.set(log(), scrollTopFor(60, 10));
    fireEvent.scroll(log());
    expect(pinned()).toBe("false");
    expect(screen.getByText("row 10")).toBeInTheDocument();
    rerender(<ActivityList rows={rows(0, 70)} />);
    // The view stayed on row 10 although ten rows arrived below it.
    expect(log().scrollTop).toBe(scrollTopFor(70, 10));
    expect(screen.getByText("row 10")).toBeInTheDocument();
    expect(screen.queryByText("row 69")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(log().scrollTop).toBe(0);
    expect(pinned()).toBe("true");
    expect(screen.getByText("row 69")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
    // Pinned again: new rows follow.
    rerender(<ActivityList rows={rows(0, 75)} />);
    expect(screen.getByText("row 74")).toBeInTheDocument();
  });

  it("scrolling back to the bottom pins again", () => {
    render(<ActivityList rows={rows(0, 100)} />);
    scrollTops.set(log(), scrollTopFor(100, 20));
    fireEvent.scroll(log());
    expect(pinned()).toBe("false");
    scrollTops.set(log(), 0);
    fireEvent.scroll(log());
    expect(pinned()).toBe("true");
  });

  it("End pins again, Home goes to the top (keyboard)", () => {
    render(<ActivityList rows={rows(0, 100)} />);
    scrollTops.set(log(), scrollTopFor(100, 5));
    fireEvent.scroll(log());
    expect(pinned()).toBe("false");
    fireEvent.keyDown(log(), { key: "End" });
    expect(pinned()).toBe("true");
    expect(log().scrollTop).toBe(0);
    fireEvent.keyDown(log(), { key: "Home" });
    expect(log().scrollTop).toBe(-(100 * ROW_H - VIEW_H));
  });

  it("keeps the reader's rows in view when the ring buffer drops old ones while unpinned", () => {
    const { rerender } = render(<ActivityList rows={rows(0, ACTIVITY_CAP)} />);
    scrollTops.set(log(), scrollTopFor(ACTIVITY_CAP, 200));
    fireEvent.scroll(log());
    expect(screen.getByText("row 200")).toBeInTheDocument();
    // 30 rows appended, the oldest 30 dropped: row 200 now sits at index 170.
    act(() => rerender(<ActivityList rows={rows(30, ACTIVITY_CAP + 30)} />));
    expect(log().scrollTop).toBe(scrollTopFor(ACTIVITY_CAP, 170));
    expect(screen.getByText("row 200")).toBeInTheDocument();
  });
});

describe("rows keep their place when the log trims (R6.4)", () => {
  const topOf = (el: Element) => (el as HTMLElement).style.top;

  it("an append at the cap changes one transform, adds one row, drops one; the rest keep node and top", () => {
    const { rerender } = render(<ActivityList rows={rows(0, ACTIVITY_CAP)} />);
    const before = new Map(mounted().map((li) => [li.getAttribute("data-row"), li]));
    const list = mounted()[0]!.parentElement as HTMLElement;
    const transform0 = list.style.transform;
    rerender(<ActivityList rows={rows(1, ACTIVITY_CAP + 1)} />);
    const after = mounted();
    const kept = after.filter((li) => before.get(li.getAttribute("data-row")) === li);
    // Same DOM node, same top: nothing to repaint for these.
    for (const li of kept) expect(topOf(li)).toBe(topOf(before.get(li.getAttribute("data-row"))!));
    expect(after.length - kept.length).toBe(1);
    expect(kept.length).toBe(before.size - 1);
    expect(list.style.transform).not.toBe(transform0);
  });

  it("the visible row order and offsets are the same as before the change", () => {
    render(<ActivityList rows={rows(1500, 1500 + ACTIVITY_CAP)} />);
    const list = mounted()[0]!.parentElement as HTMLElement;
    const shift = Number(/translateY\((-?[\d.]+)px\)/.exec(list.style.transform)![1]);
    // Final y of a row = its top + the list's translate = its index from the oldest kept row.
    const li = mounted().at(-1)!;
    const idx = Number(li.getAttribute("data-row")) - 1500;
    expect(parseFloat(li.style.top) + shift).toBe(idx * ROW_H);
  });

  it("every mounted row sits at index * ROW_H on both sides of a rebase boundary", () => {
    const check = (from: number) => {
      const list = mounted()[0]!.parentElement as HTMLElement;
      const shift = Number(/translateY\((-?[\d.]+)px\)/.exec(list.style.transform)![1]);
      expect(mounted().length).toBeGreaterThan(0);
      for (const li of mounted()) {
        const idx = Number(li.getAttribute("data-row")) - from;
        expect(parseFloat(li.style.top) + shift).toBe(idx * ROW_H);
      }
    };
    const { rerender } = render(<ActivityList rows={rows(1020, 1020 + ACTIVITY_CAP)} />);
    check(1020);
    for (const from of [1021, 1022, 1023, 1024, 1025, 2047, 2048, 2049]) {
      rerender(<ActivityList rows={rows(from, from + ACTIVITY_CAP)} />);
      check(from);
    }
  });

  it("offsets stay small however many rows have passed (rebased)", () => {
    render(<ActivityList rows={rows(5_000_000, 5_000_000 + ACTIVITY_CAP)} />);
    for (const li of mounted()) expect(parseFloat(li.style.top)).toBeLessThan(2048 * ROW_H);
  });
});
