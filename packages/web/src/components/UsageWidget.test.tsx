import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { pickFreshestRateLimits, useAccountUsage } from "../hooks/useAccountUsage";
import { STORAGE_KEYS } from "../lib/storage";
import { useBoard } from "../store/board";
import {
  CHIP_H,
  CHIP_MIN,
  CHIP_W,
  KEY_STEP,
  KEY_STEP_BIG,
  WIDGET_SIZE,
  UsageWidget,
  defaultPos,
} from "./UsageWidget";

const NOW = 1_800_000_000_000;
const KEY = STORAGE_KEYS.usageWidget;

function snap(id: string, rl?: Partial<SessionSnapshot["rate_limits"]>): SessionSnapshot {
  const base = createSnapshot({ session_id: id, host: "h", cwd: "/w/p", ts: NOW });
  return { ...base, rate_limits: { ...base.rate_limits, ...rl } };
}

function setViewport(w: number, h: number) {
  vi.stubGlobal("innerWidth", w);
  vi.stubGlobal("innerHeight", h);
}

function box() {
  const el = screen.getByTestId("usage-widget");
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top), el };
}

// jsdom has no PointerEvent: a MouseEvent subclass carries clientX/Y and pointerId to React.
function stubPointerEvent() {
  if (typeof window.PointerEvent !== "undefined") return;
  class PE extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal("PointerEvent", PE);
}

beforeEach(() => {
  stubPointerEvent();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setViewport(1440, 900);
  useBoard.setState({ sessions: {}, connection: "mock" });
});
afterEach(() => vi.useRealTimers());

describe("pickFreshestRateLimits", () => {
  it("picks the newest captured_at across sessions and ignores unreported ones", () => {
    const old = {
      five_hour: { used_pct: 10, resets_at: NOW + 1000 },
      seven_day: null,
      captured_at: NOW - 5000,
    };
    const fresh = {
      five_hour: { used_pct: 55, resets_at: NOW + 1000 },
      seven_day: { used_pct: 20, resets_at: NOW + 1000 },
      captured_at: NOW - 100,
    };
    const got = pickFreshestRateLimits({
      a: snap("a", old),
      b: snap("b", fresh),
      c: snap("c"),
    });
    expect(got).toEqual(fresh);
    expect(pickFreshestRateLimits({ c: snap("c") })).toBeNull();
    expect(pickFreshestRateLimits({})).toBeNull();
  });
});

describe("captured_at", () => {
  it("is the larger of the two winning values, and 0 is a value, not absence", () => {
    const got = pickFreshestRateLimits({
      a: snap("a", {
        five_hour: { used_pct: 1, resets_at: NOW },
        seven_day: null,
        captured_at: 0,
      }),
    });
    expect(got?.captured_at).toBe(0);
    const two = pickFreshestRateLimits({
      a: snap("a", { five_hour: { used_pct: 1, resets_at: NOW }, captured_at: 7 }),
      b: snap("b", { seven_day: { used_pct: 2, resets_at: NOW }, captured_at: 9 }),
    });
    expect(two?.captured_at).toBe(9);
  });

  it("is null only when neither winning window has one", () => {
    const got = pickFreshestRateLimits({
      a: snap("a", { five_hour: { used_pct: 1, resets_at: NOW }, captured_at: null }),
    });
    expect(got?.captured_at).toBeNull();
  });

  it("the hook reports it", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", { five_hour: { used_pct: 1, resets_at: NOW }, captured_at: 5 }),
        b: snap("b", { seven_day: { used_pct: 2, resets_at: NOW }, captured_at: 0 }),
      },
    });
    const { result } = renderHook(() => useAccountUsage());
    expect(result.current?.captured_at).toBe(5);
  });
});

describe("useAccountUsage identity", () => {
  it("keeps window objects when a replaced snapshot carries the same used_pct and resets_at", () => {
    const rl = (pct: number) => ({
      five_hour: { used_pct: pct, resets_at: NOW + 1000 },
      seven_day: { used_pct: 5, resets_at: NOW + 2000 },
      captured_at: NOW,
    });
    useBoard.setState({ sessions: { a: snap("a", rl(10)) } });
    const { result } = renderHook(() => useAccountUsage());
    const first = result.current;
    act(() => useBoard.setState({ sessions: { a: snap("a", rl(10)) } }));
    expect(result.current).toBe(first);
    act(() => useBoard.setState({ sessions: { a: snap("a", rl(11)) } }));
    expect(result.current).not.toBe(first);
    expect(result.current?.five_hour?.used_pct).toBe(11);
    expect(result.current?.seven_day).toBe(first?.seven_day);
  });
});

describe("per-window freshness", () => {
  it("takes each window from the freshest payload that has it", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", {
          five_hour: { used_pct: 70, resets_at: NOW + 1000 },
          seven_day: null,
          captured_at: NOW - 100,
        }),
        b: snap("b", {
          five_hour: { used_pct: 10, resets_at: NOW + 1000 },
          seven_day: { used_pct: 33, resets_at: NOW + 1000 },
          captured_at: NOW - 9000,
        }),
      },
    });
    render(<UsageWidget />);
    expect(screen.getByLabelText("5 hour window")).toHaveTextContent("70%");
    expect(screen.getByLabelText("7 day window")).toHaveTextContent("33%");
  });
});

describe("UsageWidget thresholds", () => {
  it.each([
    [59, "ok"],
    [60, "warn"],
    [85, "warn"],
    [86, "high"],
  ])("5h and 7d at %i percent carry data-level %s", (pct, level) => {
    const w = { used_pct: pct, resets_at: NOW + 1000 };
    useBoard.setState({
      sessions: { a: snap("a", { five_hour: w, seven_day: w, captured_at: NOW }) },
    });
    render(<UsageWidget />);
    for (const label of ["5 hour window", "7 day window"]) {
      expect(screen.getByLabelText(label).querySelector("[data-meter]")).toHaveAttribute(
        "data-level",
        level,
      );
    }
  });
});

describe("UsageWidget content", () => {
  it("renders percent, meter and reset times for both windows", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", {
          five_hour: { used_pct: 41, resets_at: NOW + 7_800_000 },
          seven_day: { used_pct: 63, resets_at: NOW + 3 * 86_400_000 },
          captured_at: NOW,
        }),
      },
    });
    render(<UsageWidget />);
    const five = screen.getByLabelText("5 hour window");
    const seven = screen.getByLabelText("7 day window");
    expect(five).toHaveTextContent("41%");
    expect(five).toHaveTextContent("resets in 2h 10m");
    expect(five).toHaveTextContent(/\d\d:\d\d/);
    expect(seven).toHaveTextContent("63%");
    expect(seven).toHaveTextContent(/resets [A-Z][a-z]{2} · [A-Z][a-z]{2} \d\d:\d\d/);
    expect(five.querySelector('[data-slot="bar"]')).toBeInTheDocument();
    expect(five.querySelector("[data-meter]")).toHaveAttribute(
      "aria-label",
      "5 hour window 41 percent",
    );
  });

  it("shows a stale window as n/a", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", {
          five_hour: { used_pct: 88, resets_at: NOW - 1 },
          seven_day: { used_pct: 50, resets_at: NOW + 1000 },
          captured_at: NOW - 5000,
        }),
      },
    });
    render(<UsageWidget />);
    const five = screen.getByLabelText("5 hour window");
    expect(five).toHaveTextContent("n/a");
    expect(five).not.toHaveTextContent("88");
    expect(screen.getByLabelText("7 day window")).toHaveTextContent("50%");
  });

  it("empty state when nothing reported, with no invented numbers", () => {
    useBoard.setState({ sessions: { a: snap("a") } });
    render(<UsageWidget />);
    expect(screen.getByTestId("usage-empty")).toHaveTextContent("not reported yet");
    expect(screen.getByTestId("usage-widget").textContent).not.toMatch(/\d+%/);
  });

  it("never mentions fable or any per-model window", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", {
          five_hour: { used_pct: 41, resets_at: NOW + 1000 },
          seven_day: { used_pct: 63, resets_at: NOW + 1000 },
          captured_at: NOW,
        }),
      },
    });
    const { container, rerender } = render(<UsageWidget />);
    expect(container.ownerDocument.body.innerHTML.toLowerCase()).not.toContain("fable");
    fireEvent.click(screen.getByTestId("usage-collapse"));
    rerender(<UsageWidget />);
    expect(container.ownerDocument.body.innerHTML.toLowerCase()).not.toContain("fable");
  });

  it("ticks past resets_at to n/a", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", {
          five_hour: { used_pct: 88, resets_at: NOW + 10_000 },
          seven_day: null,
          captured_at: NOW,
        }),
      },
    });
    render(<UsageWidget />);
    expect(screen.getByLabelText("5 hour window")).toHaveTextContent("88%");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByLabelText("5 hour window")).not.toHaveTextContent("88");
  });
});

describe("UsageWidget placement", () => {
  it("starts in the bottom-right corner, fully inside the viewport", () => {
    render(<UsageWidget />);
    const d = defaultPos(false, 1440, 900);
    const b = box();
    expect(b).toMatchObject(d);
    expect(b.x + WIDGET_SIZE).toBeLessThanOrEqual(1440);
    expect(b.y + WIDGET_SIZE).toBeLessThanOrEqual(900);
  });

  it("pointer drag moves the widget and persists on release", () => {
    render(<UsageWidget />);
    const h = screen.getByTestId("usage-handle");
    const start = box();
    fireEvent.pointerDown(h, {
      clientX: start.x + 5,
      clientY: start.y + 5,
      pointerId: 1,
      button: 0,
    });
    fireEvent.pointerMove(h, { clientX: start.x - 95, clientY: start.y - 45, pointerId: 1 });
    expect(box()).toMatchObject({ x: start.x - 100, y: start.y - 50 });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerUp(h, { pointerId: 1 });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({
      x: start.x - 100,
      y: start.y - 50,
      collapsed: false,
    });
  });

  it("a click on the handle without movement does not persist a position", () => {
    render(<UsageWidget />);
    const h = screen.getByTestId("usage-handle");
    const s = box();
    fireEvent.pointerDown(h, { clientX: s.x, clientY: s.y, pointerId: 1, button: 0 });
    fireEvent.pointerUp(h, { pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("drag cannot leave the viewport", () => {
    render(<UsageWidget />);
    const h = screen.getByTestId("usage-handle");
    const s = box();
    fireEvent.pointerDown(h, { clientX: s.x, clientY: s.y, pointerId: 1, button: 0 });
    fireEvent.pointerMove(h, { clientX: -500, clientY: -500, pointerId: 1 });
    expect(box()).toMatchObject({ x: 0, y: 0 });
    fireEvent.pointerMove(h, { clientX: 9999, clientY: 9999, pointerId: 1 });
    expect(box()).toMatchObject({ x: 1440 - WIDGET_SIZE, y: 900 - WIDGET_SIZE });
    fireEvent.pointerUp(h, { pointerId: 1 });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({
      x: 1440 - WIDGET_SIZE,
      y: 900 - WIDGET_SIZE,
    });
  });

  it("arrow keys move by a step, Shift by a larger step, and persist", () => {
    render(<UsageWidget />);
    const h = screen.getByTestId("usage-handle");
    const s = box();
    fireEvent.keyDown(h, { key: "ArrowLeft" });
    expect(box().x).toBe(s.x - KEY_STEP);
    fireEvent.keyDown(h, { key: "ArrowUp", shiftKey: true });
    expect(box().y).toBe(s.y - KEY_STEP_BIG);
    fireEvent.keyDown(h, { key: "ArrowDown" });
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(box()).toMatchObject({ x: s.x, y: s.y - KEY_STEP_BIG + KEY_STEP });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({
      x: s.x,
      y: s.y - KEY_STEP_BIG + KEY_STEP,
    });
  });

  it("restores a stored position after remount", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ x: 100, y: 120, collapsed: false }));
    render(<UsageWidget />);
    expect(box()).toMatchObject({ x: 100, y: 120 });
  });

  it("an out-of-range stored position snaps inside the viewport on load", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ x: 99999, y: -40, collapsed: false }));
    render(<UsageWidget />);
    expect(box()).toMatchObject({ x: 1440 - WIDGET_SIZE, y: 0 });
  });

  it.each(["{not json", "null", "42", '{"x":"a","y":null}', '{"x":NaN}'])(
    "junk storage %s falls back to the default corner",
    (junk) => {
      window.localStorage.setItem(KEY, junk);
      render(<UsageWidget />);
      expect(box()).toMatchObject(defaultPos(false, 1440, 900));
    },
  );

  it("storage that throws on read and write still works", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    render(<UsageWidget />);
    expect(box()).toMatchObject(defaultPos(false, 1440, 900));
    fireEvent.keyDown(screen.getByTestId("usage-handle"), { key: "ArrowLeft" });
    fireEvent.click(screen.getByTestId("usage-collapse"));
    expect(screen.getByTestId("usage-widget")).toHaveAttribute("data-collapsed", "true");
  });

  it("snaps back inside the viewport when the window shrinks", () => {
    render(<UsageWidget />);
    expect(box().x).toBeGreaterThan(400);
    setViewport(390, 700);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(box()).toMatchObject(defaultPos(false, 390, 700));
  });

  it("fits at 390 px wide", () => {
    setViewport(390, 844);
    render(<UsageWidget />);
    const b = box();
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + WIDGET_SIZE).toBeLessThanOrEqual(390);
  });
});

describe("UsageWidget collapse", () => {
  it("chip constants meet the content-fit minimum and stay under the modal scrim", () => {
    expect(CHIP_H).toBeGreaterThanOrEqual(CHIP_MIN.h);
    expect(CHIP_W).toBeGreaterThanOrEqual(CHIP_MIN.w);
    render(<UsageWidget />);
    expect(screen.getByTestId("usage-widget").className).toContain("z-20");
  });

  it("aria-controls only points at an existing body", () => {
    render(<UsageWidget />);
    const btn = screen.getByTestId("usage-collapse");
    const id = btn.getAttribute("aria-controls")!;
    expect(document.getElementById(id)).not.toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId("usage-collapse")).not.toHaveAttribute("aria-controls");
  });

  it("collapses to a chip, expands back, and persists the state", () => {
    const first = render(<UsageWidget />);
    const btn = screen.getByTestId("usage-collapse");
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(btn);
    const el = screen.getByTestId("usage-widget");
    expect(el).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("usage-collapse")).toHaveAttribute("aria-expanded", "false");
    expect(el.style.width).toBe(`${CHIP_W}px`);
    expect(el.style.height).toBe(`${CHIP_H}px`);
    expect(JSON.parse(window.localStorage.getItem(KEY)!).collapsed).toBe(true);
    first.unmount();

    render(<UsageWidget />);
    expect(screen.getByTestId("usage-widget")).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(screen.getByTestId("usage-collapse"));
    expect(screen.getByTestId("usage-widget")).toHaveAttribute("data-collapsed", "false");
    expect(JSON.parse(window.localStorage.getItem(KEY)!).collapsed).toBe(false);
  });

  it("chip shows numbers, not color alone, and stays inside the viewport after expand", () => {
    useBoard.setState({
      sessions: {
        a: snap("a", {
          five_hour: { used_pct: 41, resets_at: NOW + 1000 },
          seven_day: { used_pct: 63, resets_at: NOW + 1000 },
          captured_at: NOW,
        }),
      },
    });
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ x: 1440 - CHIP_W, y: 900 - CHIP_H, collapsed: true }),
    );
    render(<UsageWidget />);
    expect(screen.getByTestId("usage-collapse")).toHaveTextContent("5h 41% · 7d 63%");
    fireEvent.click(screen.getByTestId("usage-collapse"));
    expect(box()).toMatchObject({ x: 1440 - CHIP_W, y: 900 - WIDGET_SIZE });
  });
});
