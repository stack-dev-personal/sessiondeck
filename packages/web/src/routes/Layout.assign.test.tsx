import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { SESSION_MIME, hasSessionDrag, sessionFromDrop } from "../components/layout/dnd";
import { buildPreset } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";
import { useUi } from "../store/ui";
import { Layout } from "./Layout";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const sess = (id: string, at: number, state: SessionState = "working"): SessionSnapshot => ({
  ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: 1 }),
  project_dir: `/w/${id}`,
  session_name: `name-${id}`,
  state,
  last_event_at: at,
});
const put = (...l: SessionSnapshot[]) =>
  useBoard.setState({ sessions: Object.fromEntries(l.map((x) => [x.session_id, x])) });
const mount = () =>
  render(
    <MemoryRouter initialEntries={["/layout"]}>
      <Layout />
    </MemoryRouter>,
  );
const held = () => panesOf(useLayout.getState().spec).map((p) => p.sessionId ?? null);
const pane = (id: string) => document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)!;

/** jsdom has no DataTransfer; a plain object with the three members the handlers use. */
function transfer(id?: string) {
  const data: Record<string, string> = id ? { [SESSION_MIME]: id } : {};
  return {
    get types() {
      return Object.keys(data);
    },
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => void (data[t] = v),
    effectAllowed: "uninitialized",
    dropEffect: "none",
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  window.localStorage.clear();
  useUi.setState({ modalOpen: false, selectedSessionId: null });
  useLayout.setState({ spec: buildPreset("pair"), snapshot: null });
  put(sess("A", 30), sess("B", 20), sess("C", 10), sess("W", 1, "waiting_input"));
  useBoard.setState({ connection: "mock", loaded: true });
});

describe("arrange keys (R6.2)", () => {
  it("a arranges for the live count and places sessions in attention order", async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard("a");
    expect(useLayout.getState().spec.id).toBe("quad");
    expect(held()).toEqual(["W", "A", "B", "C"]);
    expect(screen.getByTestId("layout-notice")).toHaveTextContent("Arranged 4 live sessions: Quad");
  });
  it("a ignores ended sessions; with none live it is the strip", async () => {
    put(sess("E", 5, "ended"), sess("X", 6, "exited"));
    const user = userEvent.setup();
    mount();
    await user.keyboard("a");
    expect(useLayout.getState().spec.id).toBe("strip");
  });
  it("p splits by project", async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard("p");
    expect(useLayout.getState().spec.id).toBe("by-project");
    expect(panesOf(useLayout.getState().spec).map((p) => p.projectDir)).toEqual([
      "/w/W",
      "/w/A",
      "/w/B",
      "/w/C",
    ]);
  });
  it("the toolbar buttons do the same", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId("arrange"));
    expect(useLayout.getState().spec.id).toBe("quad");
    await user.click(screen.getByTestId("split-by-project"));
    expect(useLayout.getState().spec.id).toBe("by-project");
  });
  it("past six live sessions the hint names the rest", async () => {
    put(...Array.from({ length: 9 }, (_, i) => sess(`s${i}`, 100 - i)));
    const user = userEvent.setup();
    mount();
    await user.keyboard("a");
    expect(useLayout.getState().spec.id).toBe("grid6");
    expect(screen.getByTestId("sessions-more")).toHaveTextContent("+3 more live sessions");
  });
  it("the keys are quiet while the picker dialog is open", async () => {
    const user = userEvent.setup();
    mount();
    pane("p0").focus();
    await user.keyboard("{Enter}");
    await user.keyboard("p"); // typed into the filter, not the by-project key
    expect(useLayout.getState().spec.id).toBe("pair");
    expect(screen.getByRole("combobox")).toHaveValue("p");
  });
});

describe("keyboard assignment (R6.6)", () => {
  it("a focused session pane has a tab stop; Enter opens the picker in attention order", async () => {
    const user = userEvent.setup();
    mount();
    pane("p1").focus();
    await user.keyboard("{Enter}");
    const dlg = screen.getByRole("dialog", { name: "Assign a session to pane 2" });
    const rows = within(dlg).getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("data-session-id"))).toEqual(["W", "A", "B", "C"]);
    expect(within(dlg).getByRole("combobox")).toHaveFocus();
  });
  it("type to filter, arrows move, Enter assigns, focus returns to the pane", async () => {
    const user = userEvent.setup();
    mount();
    pane("p1").focus();
    await user.keyboard("g");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(held()).toEqual([null, "B"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pane("p1")).toHaveFocus();
    expect(useUi.getState().modalOpen).toBe(false);
    await user.keyboard("g");
    await user.keyboard("name-c{Enter}");
    expect(held()).toEqual([null, "C"]);
  });
  it("picking a session shown elsewhere moves it; picking onto an occupied pane swaps", async () => {
    useLayout.getState().assign("p0", "A");
    useLayout.getState().assign("p1", "B");
    const user = userEvent.setup();
    mount();
    pane("p1").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("option", { name: /name-A/ })).toHaveTextContent("in pane 1");
    await user.keyboard("name-a{Enter}");
    expect(held()).toEqual(["B", "A"]);
  });
  it("Esc cancels without changes and returns focus; no match says so", async () => {
    const user = userEvent.setup();
    mount();
    pane("p0").focus();
    await user.keyboard("{Enter}zzz");
    expect(screen.getByText("No session matches.")).toBeInTheDocument();
    await user.keyboard("{Enter}"); // nothing highlighted: nothing happens
    expect(held()).toEqual([null, null]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pane("p0")).toHaveFocus();
  });
  it("Delete and Backspace unassign the focused pane", async () => {
    useLayout.getState().assign("p0", "A");
    useLayout.getState().assign("p1", "B");
    const user = userEvent.setup();
    mount();
    pane("p0").focus();
    await user.keyboard("{Delete}");
    pane("p1").focus();
    await user.keyboard("{Backspace}");
    expect(held()).toEqual([null, null]);
  });
  it("the Assign button opens the picker, and a click on a row assigns", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(pane("p0")).getByRole("button", { name: /Assign a session/ }));
    await user.click(screen.getByRole("option", { name: /name-C/ }));
    expect(held()).toEqual(["C", null]);
  });
  it("board and project panes are not tab stops for assignment", async () => {
    useLayout.setState({ spec: buildPreset("solo") });
    mount();
    expect(pane("p0")).not.toHaveAttribute("tabindex");
    expect(pane("p1")).toHaveAttribute("tabindex", "0");
  });
  it("an assignment made while compacted survives the restore", async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard("{Shift>}C{/Shift}");
    act(() => useLayout.getState().assign("p0", "A"));
    await user.keyboard("{Shift>}C{/Shift}");
    expect(held()).toEqual(["A", null]);
  });
});

describe("drag assignment (R6.6)", () => {
  it("dnd helpers read only the private type", () => {
    expect(hasSessionDrag(transfer("A"))).toBe(true);
    expect(hasSessionDrag({ types: ["text/plain", "Files"] })).toBe(false);
    expect(sessionFromDrop(transfer("A"))).toBe("A");
    expect(sessionFromDrop(transfer())).toBeNull();
    expect(sessionFromDrop(null)).toBeNull();
  });
  it("dropping a session on a session pane assigns it; dragover shows the target", () => {
    mount();
    const dt = transfer("A");
    fireEvent.dragEnter(pane("p0"), { dataTransfer: dt });
    const over = createEvent.dragOver(pane("p0"), { dataTransfer: dt });
    fireEvent(pane("p0"), over);
    expect(over.defaultPrevented).toBe(true);
    expect(pane("p0")).toHaveAttribute("data-drop", "true");
    expect(within(pane("p0")).getByTestId("pane-header")).toHaveTextContent("Drop to assign");
    fireEvent.drop(pane("p0"), { dataTransfer: dt });
    expect(held()).toEqual(["A", null]);
    expect(pane("p0")).not.toHaveAttribute("data-drop");
  });
  it("dragging the same session onto another pane moves it (never in two panes)", () => {
    mount();
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("A") });
    fireEvent.drop(pane("p1"), { dataTransfer: transfer("A") });
    expect(held()).toEqual([null, "A"]);
  });
  it("a header drag carries the session id; dropping on an occupied pane swaps", () => {
    mount();
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("A") });
    fireEvent.drop(pane("p1"), { dataTransfer: transfer("B") });
    const dt = transfer();
    fireEvent.dragStart(within(pane("p0")).getByTestId("pane-header"), { dataTransfer: dt });
    expect(dt.getData(SESSION_MIME)).toBe("A");
    fireEvent.drop(pane("p1"), { dataTransfer: dt });
    expect(held()).toEqual(["B", "A"]);
  });
  it("a strip card is a drag source", () => {
    useLayout.setState({ spec: buildPreset("solo") });
    mount();
    const card = within(screen.getByRole("list", { name: "Board strip" })).getAllByRole("listitem");
    const dt = transfer();
    fireEvent.dragStart(card[0]!, { dataTransfer: dt });
    expect(dt.getData(SESSION_MIME)).toBe("W");
    fireEvent.drop(pane("p1"), { dataTransfer: dt });
    expect(held()).toEqual([null, "W"]);
  });
  it("foreign drags (files, text) and non-session panes are ignored", () => {
    useLayout.setState({ spec: buildPreset("solo") });
    mount();
    const over = createEvent.dragOver(pane("p1"), { dataTransfer: { types: ["Files"] } });
    fireEvent(pane("p1"), over);
    expect(over.defaultPrevented).toBe(false);
    fireEvent.drop(pane("p1"), { dataTransfer: { types: ["text/plain"], getData: () => "A" } });
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("A") }); // the board pane
    expect(held()).toEqual([null, null]);
  });
});

describe("review fixes (R6.6, R6.2)", () => {
  it("the picker highlight follows the session when the list re-sorts under it", async () => {
    const user = userEvent.setup();
    mount();
    pane("p1").focus();
    await user.keyboard("g{ArrowDown}"); // W, [A]
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("data-session-id", "A");
    act(() =>
      put(
        sess("A", 30),
        sess("B", 20),
        sess("C", 50, "waiting_input"),
        sess("W", 1, "waiting_input"),
      ),
    );
    expect(screen.getAllByRole("option").map((r) => r.getAttribute("data-session-id"))).toEqual([
      "C",
      "W",
      "A",
      "B",
    ]);
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("data-session-id", "A");
    await user.keyboard("{Enter}");
    expect(held()).toEqual([null, "A"]);
  });
  it("each session pane has its own accessible name with its number and session", () => {
    useLayout.getState().assign("p1", "B");
    mount();
    expect(screen.getByRole("region", { name: "Session pane 1: unassigned" })).toBe(pane("p0"));
    expect(screen.getByRole("region", { name: "Session pane 2: name-B" })).toBe(pane("p1"));
  });
  it("a dropped id that is not on the board is ignored", () => {
    mount();
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("not-a-session") });
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("__proto__") });
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("toString") });
    expect(held()).toEqual([null, null]);
    expect(window.localStorage.getItem("sd.layout") ?? "").not.toContain("not-a-session");
    fireEvent.drop(pane("p0"), { dataTransfer: transfer("A") });
    expect(held()).toEqual(["A", null]);
  });
  it("g opens the picker with Caps Lock on", async () => {
    const user = userEvent.setup();
    mount();
    pane("p0").focus();
    fireEvent.keyDown(pane("p0"), { key: "G", shiftKey: false });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });
  it("+N more projects counts only projects with a live session", async () => {
    put(
      ...Array.from({ length: 3 }, (_, i) => sess(`s${i}`, 100 - i)),
      sess("e1", 1, "ended"),
      sess("e2", 2, "exited"),
    );
    const user = userEvent.setup();
    mount();
    await user.keyboard("p");
    expect(panesOf(useLayout.getState().spec)).toHaveLength(3);
    expect(screen.queryByTestId("projects-more")).toBeNull();
  });
  it("+N more live sessions shows after Arrange, not for a grid6 picked from the menu", async () => {
    put(...Array.from({ length: 9 }, (_, i) => sess(`s${i}`, 100 - i)));
    useLayout.setState({ spec: buildPreset("grid6") });
    const user = userEvent.setup();
    mount();
    expect(screen.queryByTestId("sessions-more")).toBeNull();
    await user.keyboard("a");
    expect(screen.getByTestId("sessions-more")).toBeInTheDocument();
  });
  it("by-project columns past the visible width say how many are off to the right", () => {
    put(...Array.from({ length: 8 }, (_, i) => sess(`s${i}`, 100 - i)));
    useLayout.setState({ spec: buildPreset("by-project", panesOfDirs(8)) });
    const proto = HTMLElement.prototype;
    const dims = { scrollWidth: 2400, clientWidth: 900, scrollLeft: 0 };
    const orig = Object.fromEntries(
      Object.keys(dims).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]),
    );
    for (const k of Object.keys(dims))
      Object.defineProperty(proto, k, {
        configurable: true,
        get: () => dims[k as keyof typeof dims],
      });
    try {
      mount();
      expect(screen.getByTestId("columns-more")).toHaveTextContent("Scroll for 5 more columns");
      dims.scrollLeft = 1500;
      fireEvent.scroll(screen.getByTestId("split-scroll"));
      expect(screen.queryByTestId("columns-more")).toBeNull();
    } finally {
      for (const [k, d] of Object.entries(orig)) {
        if (d) Object.defineProperty(proto, k, d);
        else delete (proto as unknown as Record<string, unknown>)[k];
      }
    }
  });
});

describe("by-project columns are not clipped (R6.1)", () => {
  it("many columns scroll the whole row at a minimum column width", () => {
    put(...Array.from({ length: 8 }, (_, i) => sess(`s${i}`, 100 - i)));
    useLayout.setState({ spec: buildPreset("by-project", panesOfDirs(8)) });
    mount();
    const scroller = screen.getByTestId("split-scroll");
    expect(scroller.firstElementChild).toHaveStyle({ minWidth: "240rem" });
    expect(scroller.className).toContain("overflow-x-auto");
  });
  it("other splits are not wrapped", () => {
    mount();
    expect(screen.queryByTestId("split-scroll")).toBeNull();
  });
});

function panesOfDirs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `/w/s${i}`);
}
