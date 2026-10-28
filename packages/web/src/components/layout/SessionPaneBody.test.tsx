import { createSnapshot } from "@sessiondeck/contract";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutSpec } from "../../layout/spec";
import { appendRows } from "../../store/activity";
import { useBoard } from "../../store/board";
import { useLayout } from "../../store/layout";
import { LayoutView } from "./LayoutView";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Controllable IntersectionObserver: tests flip a pane on and off screen. */
const ios: { cb: (e: { isIntersecting: boolean }[]) => void; el: Element }[] = [];
class IO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe(el: Element) {
    ios.push({ cb: this.cb, el });
  }
  unobserve() {}
  disconnect() {
    for (let i = ios.length - 1; i >= 0; i--) if (ios[i]!.cb === this.cb) ios.splice(i, 1);
  }
}

const seed = (id: string, count: number) => {
  const s = createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: 1 });
  let log = appendRows(undefined, 1, []);
  for (let i = 0; i < count; i++)
    log = appendRows(log, 1, [{ kind: "event", text: `${id} #${i}` }]);
  return { s, log };
};

const spec = (compact: boolean): LayoutSpec => ({
  version: 1,
  id: "solo-x",
  name: "x",
  root: {
    kind: "split",
    dir: "row",
    ratios: [0.5, 0.5],
    children: [
      { kind: "pane", id: "p1", type: "session", sessionId: "A", compact },
      { kind: "pane", id: "p2", type: "session", sessionId: "B" },
    ],
  },
});

function Live() {
  return <LayoutView spec={useLayout((s) => s.spec)} />;
}

beforeEach(() => {
  ios.length = 0;
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("IntersectionObserver", IO);
  window.localStorage.clear();
  const a = seed("A", 500);
  const b = seed("B", 5);
  useBoard.setState({
    sessions: { A: a.s, B: b.s },
    activity: { A: a.log, B: b.log },
    connection: "mock",
  });
});

const lists = () => screen.queryAllByTestId("activity-list");

/** The observer's first report: every observed pane is on screen. */
const reveal = () =>
  act(() => {
    for (const io of [...ios]) io.cb([{ isIntersecting: true }]);
  });

describe("SessionPaneBody (R6.4)", () => {
  it("renders a windowed list: far fewer DOM rows than the 500 buffered", () => {
    useLayout.setState({ spec: spec(false) });
    render(<Live />);
    reveal();
    expect(lists()).toHaveLength(2);
    const [first] = screen.getAllByRole("log");
    expect(first).toHaveAttribute("data-total", "500");
    expect(first!.querySelectorAll("li").length).toBeLessThan(60);
    expect(screen.getAllByTestId("session-status")[0]).toHaveTextContent("Starting");
  });

  it("a compacted pane has no list (and no log) at all", () => {
    useLayout.setState({ spec: spec(true) });
    render(<Live />);
    reveal();
    expect(lists()).toHaveLength(1);
    expect(document.querySelectorAll('[data-pane-id="p1"] [data-row]')).toHaveLength(0);
    act(() => useLayout.getState().setPaneCompact("p1", false));
    reveal();
    expect(lists()).toHaveLength(2);
    act(() => useLayout.getState().setPaneCompact("p1", true));
    expect(lists()).toHaveLength(1);
  });

  it("a pane scrolled out of view unmounts its list and mounts it again when it returns", () => {
    useLayout.setState({ spec: spec(false) });
    render(<Live />);
    reveal();
    expect(lists()).toHaveLength(2);
    const target = document.querySelector('[data-pane-id="p1"] [data-testid="session-body"]')!;
    const io = ios.find((x) => x.el === target)!;
    act(() => io.cb([{ isIntersecting: false }]));
    expect(lists()).toHaveLength(1);
    expect(document.querySelector('[data-pane-id="p1"] [data-slot="activity"]')).toHaveAttribute(
      "data-mounted",
      "false",
    );
    // The buffer kept filling meanwhile; it comes back whole.
    act(() => io.cb([{ isIntersecting: true }]));
    expect(lists()).toHaveLength(2);
  });

  it("a pane assigned after the first render is observed and unmounts its list off screen (R6.6)", () => {
    useLayout.setState({
      spec: {
        version: 1,
        id: "solo-x",
        name: "x",
        root: { kind: "pane", id: "p1", type: "session" },
      },
    });
    render(<Live />);
    reveal();
    expect(document.querySelector('[data-unassigned="true"]')).not.toBeNull();
    act(() => useLayout.getState().assign("p1", "A"));
    expect(lists()).toHaveLength(1);
    const target = document.querySelector('[data-pane-id="p1"] [data-testid="session-body"]')!;
    const io = ios.find((x) => x.el === target);
    expect(io, "an observer exists for the pane").toBeDefined();
    act(() => io!.cb([{ isIntersecting: false }]));
    expect(lists()).toHaveLength(0);
    act(() => io!.cb([{ isIntersecting: true }]));
    expect(lists()).toHaveLength(1);
  });

  it("leaving the route unmounts every list and observer", () => {
    useLayout.setState({ spec: spec(false) });
    const { unmount } = render(<Live />);
    reveal();
    expect(ios.length).toBeGreaterThan(0);
    unmount();
    expect(lists()).toHaveLength(0);
    expect(ios).toHaveLength(0);
  });

  it("shows n/a style empty states, never a blank pane", () => {
    useBoard.setState({ activity: {} });
    useLayout.setState({ spec: spec(false) });
    render(<Live />);
    reveal();
    expect(screen.getAllByText("No activity yet.")).toHaveLength(2);
  });

  it("mounts no list before the observer has reported (no one-frame mount off screen)", () => {
    useLayout.setState({ spec: spec(false) });
    render(<Live />);
    expect(lists()).toHaveLength(0);
    reveal();
    expect(lists()).toHaveLength(2);
  });

  it("a pane reassigned to another session opens pinned at the newest row, not where the last one was scrolled", () => {
    useLayout.setState({ spec: spec(false) });
    useBoard.setState({
      activity: { ...useBoard.getState().activity, B: seed("B", 120).log },
    });
    render(<Live />);
    reveal();
    const pane = () => document.querySelector('[data-pane-id="p1"]')!;
    const log = () => pane().querySelector('[role="log"]') as HTMLElement;
    // Scroll A up by 10 rows (the column-reverse box goes negative).
    act(() => {
      log().scrollTop = -240;
      log().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(pane().querySelector('[data-testid="activity-list"]')).toHaveAttribute(
      "data-pinned",
      "false",
    );
    act(() => useLayout.getState().assign("p1", "B"));
    expect(pane().querySelector('[data-testid="activity-list"]')).toHaveAttribute(
      "data-pinned",
      "true",
    );
    expect(log()).toHaveAttribute("data-total", "120");
    // The newest row of B is in the window.
    expect(pane().querySelector('[data-row="119"]')).not.toBeNull();
  });
});
