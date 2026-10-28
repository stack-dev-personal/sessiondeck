import { act, render, screen } from "@testing-library/react";
import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { useBoard } from "../store/board";
import { useFilters } from "../store/filters";
import { DEFAULT_SETTINGS, useUi } from "../store/ui";
import { reorderChildren } from "../lib/reorder";
import { Board } from "./Board";

// R3.6: at 20 deltas/s over 20 sessions the last-event sort reorders the board on nearly every
// flush. React moves every card that the moved one passes (move-to-front of the k-th card moves
// k-1 others), and each moved card is re-attached, so its subtree gets style, layout and paint
// again. The board therefore keeps React's child order stable and moves the fewest nodes itself.

// R3.10: order is by group, then by the time a card entered its group (state_since on first
// sight), never by last_event_at. A move is therefore a group change or a fresh arrival.
const snap = (id: string, at: number, state: SessionState = "working") =>
  ({
    ...createSnapshot({ session_id: id, host: "h1", cwd: `/w/${id}`, ts: 1 }),
    state,
    state_since: at,
    last_event_at: at,
  }) as SessionSnapshot;
const ids = Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(2, "0")}`);
const put = (at: Record<string, number>, states: Record<string, SessionState> = {}) =>
  act(() =>
    useBoard.setState({
      sessions: Object.fromEntries(
        Object.entries(at).map(([id, t]) => [id, snap(id, t, states[id] ?? "working")]),
      ),
    }),
  );
const order = () =>
  screen.getAllByTestId("session-card").map((c) => c.getAttribute("data-session-id"));
/** Newest first: s00 oldest ... in `at`, larger is newer. */
const stamp = (newestFirst: string[]) =>
  Object.fromEntries(newestFirst.map((id, i) => [id, 1000 - i]));

/** Counts li nodes attached to the list since the last call (a move is one removal and one add). */
function watchMoves() {
  const ul = screen.getByRole("list", { name: "Sessions" });
  const mo = new MutationObserver(() => undefined);
  mo.observe(ul, { childList: true });
  return () =>
    mo
      .takeRecords()
      .reduce((n, r) => n + Array.from(r.addedNodes).filter((x) => x.nodeName === "LI").length, 0);
}

describe("Board reorder moves the fewest nodes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useFilters.setState({ host: null, project: null });
    useUi.setState({ compact: false, selectedSessionId: null, settings: DEFAULT_SETTINGS });
    useBoard.setState({ sessions: {}, connection: "mock" });
  });

  it("moves exactly one card when one session gets the newest event", () => {
    put(stamp(ids));
    render(<Board />);
    const moved = watchMoves();
    const next = [ids[14]!, ...ids.filter((i) => i !== ids[14])];
    put(stamp(ids), { [ids[14]!]: "waiting_input" });
    expect(order()).toEqual(next);
    expect(moved()).toBe(1);
  });

  it("moves exactly one card when the first card drops to the back", () => {
    put(stamp(ids));
    render(<Board />);
    const moved = watchMoves();
    const next = [...ids.slice(1), ids[0]!];
    useUi.setState({ settings: { ...useUi.getState().settings, idleGraceSec: 0 } });
    put(stamp(ids), { [ids[0]!]: "idle" });
    expect(order()).toEqual(next);
    expect(moved()).toBe(1);
  });

  it("keeps DOM order equal to the sort for a shuffle, a new session and a removal", () => {
    put(stamp(ids));
    render(<Board />);
    const shuffled = [...ids].reverse().map((id, i) => (i % 3 === 0 ? id : ids[(i * 7) % 20]!));
    const uniq = [...new Set([...shuffled, ...ids])];
    put({});
    put(stamp(uniq));
    expect(order()).toEqual(uniq);
    const withNew = ["new1", ...uniq.slice(0, 5), ...uniq.slice(6)];
    put({});
    put(stamp(withNew));
    expect(order()).toEqual(withNew);
  });

  it("reorderChildren leaves an already sorted list untouched", () => {
    const ul = document.createElement("ul");
    for (const id of ["a", "b", "c"]) {
      const li = document.createElement("li");
      li.setAttribute("data-row", id);
      ul.append(li);
    }
    const mo = new MutationObserver(() => undefined);
    mo.observe(ul, { childList: true });
    reorderChildren(ul, ["a", "b", "c"]);
    expect(mo.takeRecords()).toHaveLength(0);
    reorderChildren(ul, ["c", "a", "b"]);
    expect(Array.from(ul.children).map((c) => c.getAttribute("data-row"))).toEqual(["c", "a", "b"]);
    expect(mo.takeRecords().flatMap((r) => Array.from(r.addedNodes))).toHaveLength(1);
  });
});
