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

  it("keeps focus on a card when it is reordered", () => {
    put(snap("a", "working", 30), snap("b", "working", 20));
    render(<Board />);
    const b = document.querySelector<HTMLElement>('[data-session-id="b"]')!;
    b.focus();
    expect(document.activeElement).toBe(b);
    put(snap("a", "working", 30), snap("b", "waiting_input", 40));
    expect(order()).toEqual(["b", "a"]);
    expect(document.activeElement).toHaveAttribute("data-session-id", "b");
  });
});
