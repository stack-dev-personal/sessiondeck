import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { useBoard } from "../store/board";
import { useFilters } from "../store/filters";
import { useUi } from "../store/ui";
import { Board } from "./Board";

function snap(id: string, state: SessionState, at: number, host = "h1", cwd = `/w/${id}`) {
  return {
    ...createSnapshot({ session_id: id, host, cwd, ts: 1 }),
    state,
    last_event_at: at,
  } as SessionSnapshot;
}
const put = (...l: SessionSnapshot[]) =>
  act(() => useBoard.setState({ sessions: Object.fromEntries(l.map((s) => [s.session_id, s])) }));
const order = () =>
  screen.getAllByTestId("session-card").map((c) => c.getAttribute("data-session-id"));

describe("Board attention order, accent and filters", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useFilters.setState({ host: null, project: null });
    useUi.setState({ compact: false, selectedSessionId: null });
    useBoard.setState({ sessions: {}, connection: "mock" });
  });

  it("moves a session to the top in the same render as its state change, with the accent", () => {
    render(<Board />);
    put(snap("a", "working", 30), snap("b", "working", 20), snap("c", "working", 10));
    expect(order()).toEqual(["a", "b", "c"]);
    put(snap("a", "working", 30), snap("b", "working", 20), snap("c", "waiting_permission", 40));
    expect(order()).toEqual(["c", "a", "b"]);
    const top = screen.getAllByTestId("session-card")[0]!;
    expect(top).toHaveAttribute("data-attention", "true");
    expect(top).toHaveClass("sd-attention");
    expect(within(top).getByText("attention")).toBeInTheDocument();
    expect(within(top).getByText("Needs permission")).toBeInTheDocument();
    expect(screen.getAllByTestId("session-card")[1]).not.toHaveAttribute("data-attention");
  });

  it("keeps the accent as glyph and word on compact rows", () => {
    useUi.setState({ compact: true });
    put(snap("a", "idle", 5), snap("b", "waiting_input", 1));
    const top = screen.queryAllByTestId("session-card");
    expect(top).toHaveLength(0);
    render(<Board />);
    const first = screen.getAllByTestId("session-card")[0]!;
    expect(first).toHaveAttribute("data-session-id", "b");
    expect(first).toHaveAttribute("data-attention", "true");
    expect(first).toHaveTextContent("Needs input");
    expect(first).toHaveTextContent("▲");
  });

  it("filters by host and project, shows the count and clears", async () => {
    put(
      snap("a", "idle", 3, "h1", "/w/alpha"),
      snap("b", "idle", 2, "h2", "/w/alpha"),
      snap("c", "idle", 1, "h2", "/w/beta"),
    );
    render(<Board />);
    expect(screen.getByTestId("board-count")).toHaveTextContent("3 sessions");
    await userEvent.selectOptions(screen.getByLabelText("Host"), "h2");
    expect(order()).toEqual(["b", "c"]);
    await userEvent.selectOptions(screen.getByLabelText("Project"), "alpha");
    expect(order()).toEqual(["b"]);
    expect(screen.getByTestId("board-count")).toHaveTextContent("Showing 1 of 3");
    expect(JSON.parse(window.localStorage.getItem("sd.filters")!)).toEqual({
      host: "h2",
      project: "alpha",
    });
    await userEvent.selectOptions(screen.getByLabelText("Host"), "h1");
    await userEvent.selectOptions(screen.getByLabelText("Project"), "beta");
    expect(screen.getByText("No sessions match the filters.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(order()).toEqual(["a", "b", "c"]);
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled();
  });

  it("keeps a stale persisted filter selectable and the toolbar present on an empty board", () => {
    useFilters.setState({ host: "gone", project: null });
    render(<Board />);
    expect(screen.getByTestId("board-toolbar")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("gone");
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });

  it("keeps focus on a card when React moves it in a reorder", () => {
    put(snap("a", "working", 30), snap("b", "working", 20));
    render(<Board />);
    const a = document.querySelector<HTMLElement>('[data-session-id="a"]')!;
    a.focus();
    expect(document.activeElement).toBe(a);
    // b becomes waiting and moves to the top: keyed reconciliation moves a, which drops focus
    put(snap("a", "working", 30), snap("b", "waiting_input", 40));
    expect(order()).toEqual(["b", "a"]);
    expect(document.activeElement).toHaveAttribute("data-session-id", "a");
  });

  it("keeps focus on the card that itself moves to the top (3 cards)", () => {
    put(snap("a", "working", 30), snap("b", "working", 20), snap("c", "working", 10));
    render(<Board />);
    const c = document.querySelector<HTMLElement>('[data-session-id="c"]')!;
    c.focus();
    expect(document.activeElement).toBe(c);
    put(snap("a", "working", 30), snap("b", "working", 20), snap("c", "waiting_input", 40));
    expect(order()).toEqual(["c", "a", "b"]);
    expect(document.activeElement).toHaveAttribute("data-session-id", "c");
  });

  it("says how many waiting sessions the filters hide", async () => {
    put(snap("a", "idle", 3, "h1"), snap("b", "idle", 2, "h2"));
    render(<Board />);
    expect(screen.queryByTestId("board-hidden-attention")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Host"), "h2");
    expect(order()).toEqual(["b"]);
    expect(screen.queryByTestId("board-hidden-attention")).toBeNull();
    put(snap("a", "waiting_permission", 9, "h1"), snap("b", "idle", 2, "h2"));
    const hint = screen.getByTestId("board-hidden-attention");
    expect(hint).toHaveTextContent("1 hidden needs attention");
    expect(hint).toHaveTextContent("▲");
    put(
      snap("a", "waiting_permission", 9, "h1"),
      snap("b", "waiting_input", 2, "h2"),
      snap("c", "waiting_input", 2, "h1"),
    );
    expect(screen.getByTestId("board-hidden-attention")).toHaveTextContent(
      "2 hidden need attention",
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.queryByTestId("board-hidden-attention")).toBeNull();
  });

  it("keeps the hidden-attention live region mounted so the hint is announced when it appears", async () => {
    put(snap("a", "idle", 3, "h1"), snap("b", "idle", 2, "h2"));
    render(<Board />);
    await userEvent.selectOptions(screen.getByLabelText("Host"), "h2");
    const region = screen.getByTestId("board-hidden-attention-region");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toBeEmptyDOMElement();
    put(snap("a", "waiting_permission", 9, "h1"), snap("b", "idle", 2, "h2"));
    expect(screen.getByTestId("board-hidden-attention-region")).toBe(region);
    expect(region).toHaveTextContent("1 hidden needs attention");
  });
});
