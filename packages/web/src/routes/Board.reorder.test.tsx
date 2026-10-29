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

  it("keeps DOM order equal to the sort for a group shuffle, a new session and a removal", () => {
    put(stamp(ids));
    render(<Board />);
    useUi.setState({ settings: { ...useUi.getState().settings, idleGraceSec: 0 } });
    const list = order();
    const moved = watchMoves();
    // Every third card waits (attention group), every fifth of the rest goes idle; the live list
    // is permuted without remounting, so reorderChildren has to move nodes.
    const states: Record<string, SessionState> = {};
    ids.forEach((id, i) => {
      if (i % 3 === 0) states[id] = "waiting_input";
      else if (i % 5 === 0) states[id] = "idle";
    });
    put(stamp(ids), states);
    const rank = (id: string) =>
      states[id] === "waiting_input" ? 0 : states[id] === "idle" ? 2 : 1;
    const got = order();
    expect([...got].sort()).toEqual([...list].sort());
    expect(got.map((x) => rank(x!))).toEqual([...got].map((x) => rank(x!)).sort((p, q) => p - q));
    // A real shuffle: some nodes moved, never more than one move per card.
    expect(moved()).toBeGreaterThan(0);
    expect(moved()).toBeLessThanOrEqual(ids.length);

    const withNew = { ...stamp(ids), new1: 2000 };
    delete (withNew as Record<string, number>)[ids[4]!];
    put(withNew, states);
    const after = order();
    expect(after).toHaveLength(20);
    expect(after).toContain("new1");
    expect(after).not.toContain(ids[4]);
    const sorted = [...after].sort((x, y) => rank(x!) - rank(y!));
    expect(after.map((x) => rank(x!))).toEqual(sorted.map((x) => rank(x!)));
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
