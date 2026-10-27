import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutSpec } from "../../layout/spec";
import type { ActivityLog } from "../../store/activity";
import { useBoard } from "../../store/board";
import { useLayout } from "../../store/layout";
import { LayoutView } from "./LayoutView";

const renders = vi.hoisted(() => ({
  lists: {} as Record<string, number>,
  chromes: {} as Record<string, number>,
}));
// Counts renders of a session's list (keyed by its first row's text) ...
vi.mock("./ActivityList", () => ({
  ActivityList: (p: { rows: readonly { text: string }[] }) => {
    const k = p.rows[0]!.text;
    renders.lists[k] = (renders.lists[k] ?? 0) + 1;
    return <div data-testid={`list-${k}`}>{p.rows[p.rows.length - 1]!.text}</div>;
  },
}));
// ... and of a session pane's chrome (it spreads the drag props of the session it holds).
vi.mock("./dnd", async (orig) => {
  const real = await orig<typeof import("./dnd")>();
  return {
    ...real,
    sessionDragProps: (id: string) => {
      renders.chromes[id] = (renders.chromes[id] ?? 0) + 1;
      return real.sessionDragProps(id);
    },
  };
});

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const snap = (id: string): SessionSnapshot => ({
  ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: 1 }),
});

const log = (text: string, extra = 0): ActivityLog => ({
  rows: Array.from({ length: 1 + extra }, (_, n) => ({
    n,
    ts: 1,
    kind: "event" as const,
    glyph: "·",
    text: n === 0 ? text : `${text}${n}`,
  })),
  total: 1 + extra,
});

const pane = (id: string, extra = {}) => ({
  kind: "pane" as const,
  id,
  type: "session" as const,
  ...extra,
});

function Live() {
  return <LayoutView spec={useLayout((s) => s.spec)} />;
}

function mountSpec(spec: LayoutSpec) {
  useLayout.setState({ spec });
  return render(<Live />);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  window.localStorage.clear();
  renders.lists = {};
  renders.chromes = {};
  useBoard.setState({
    sessions: { A: snap("A"), B: snap("B") },
    activity: { A: log("A"), B: log("B") },
    connection: "mock",
  });
});

describe("LayoutView panel ids (R6.1)", () => {
  it("a pane named like an old split id does not collide with a split", () => {
    const spec: LayoutSpec = {
      version: 1,
      id: "x",
      name: "x",
      root: {
        kind: "split",
        dir: "row",
        ratios: [0.5, 0.5],
        children: [
          pane("s1"),
          {
            kind: "split",
            dir: "column",
            ratios: [0.5, 0.5],
            children: [pane("a"), pane("b")],
          },
        ],
      },
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = mountSpec(spec);
    const ids = [...container.querySelectorAll("[data-panel]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("split:1");
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("LayoutView render isolation (R6.4, R6.5 groundwork)", () => {
  const spec: LayoutSpec = {
    version: 1,
    id: "pair-ab",
    name: "pair",
    root: {
      kind: "split",
      dir: "row",
      ratios: [0.5, 0.5],
      children: [pane("pa", { sessionId: "A" }), pane("pb", { sessionId: "B" })],
    },
  };

  it("a delta to session A does not re-render the list or chrome of the pane bound to B", () => {
    mountSpec(spec);
    expect(renders.lists["A"]).toBeGreaterThan(0);
    const b0 = renders.lists["B"];
    const a0 = renders.lists["A"]!;
    const bc0 = renders.chromes["B"];
    const ac0 = renders.chromes["A"];
    act(() =>
      useBoard.setState((st) => ({
        sessions: { ...st.sessions, A: { ...st.sessions["A"]!, state: "working" } },
        activity: { ...st.activity, A: log("A", 1) },
      })),
    );
    expect(screen.getByTestId("list-A")).toHaveTextContent("A1");
    expect(renders.lists["A"]).toBeGreaterThan(a0);
    expect(renders.lists["B"]).toBe(b0);
    expect(renders.chromes["B"]).toBe(bc0);
    // The chrome selects the display name (a string): a state change of A does not re-render it.
    expect(renders.chromes["A"]).toBe(ac0);
  });

  it("a ratio change in one split does not re-render a sibling subtree", () => {
    mountSpec(spec);
    const a0 = renders.lists["A"];
    const b0 = renders.lists["B"];
    act(() => useLayout.getState().setRatios([], [0.3, 0.7]));
    // The split itself re-renders; unchanged pane nodes are memoized by identity and path value.
    expect(renders.lists["A"]).toBe(a0);
    expect(renders.lists["B"]).toBe(b0);
  });

  it("compact panes update only when their own session line changes", () => {
    const compactSpec: LayoutSpec = {
      ...spec,
      root: {
        ...(spec.root as Extract<LayoutSpec["root"], { kind: "split" }>),
        children: [
          pane("pa", { sessionId: "A", compact: true }),
          pane("pb", { sessionId: "B", compact: true }),
        ],
      },
    };
    mountSpec(compactSpec);
    const before = screen.getAllByTestId("pane")[1]!.querySelector("p");
    act(() =>
      useBoard.setState((st) => ({
        sessions: { ...st.sessions, A: { ...st.sessions["A"]!, state: "working" } },
      })),
    );
    expect(screen.getAllByTestId("pane")[0]).toHaveTextContent("Working");
    expect(screen.getAllByTestId("pane")[1]!.querySelector("p")).toBe(before);
  });
});

describe("hostile sessionId in a stored spec (R6.3 security)", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "a pane bound to %s renders as not on the board, normal and compact",
    (sid) => {
      const spec: LayoutSpec = {
        version: 1,
        id: "hostile",
        name: "hostile",
        root: {
          kind: "split",
          dir: "row",
          ratios: [0.5, 0.5],
          children: [pane("p1", { sessionId: sid }), pane("p2", { sessionId: sid, compact: true })],
        },
      };
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mountSpec(spec);
      expect(screen.getAllByTestId("pane")).toHaveLength(2);
      expect(screen.getByText(`Session ${sid} is not on the board.`)).toBeInTheDocument();
      expect(screen.getByText(`${sid} not on the board`)).toBeInTheDocument();
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    },
  );
});
