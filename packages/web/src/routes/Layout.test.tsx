import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { buildPreset, PRESET_NAMES } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";
import { Layout } from "./Layout";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Where() {
  return <output data-testid="where">{useLocation().search}</output>;
}

const mount = (url = "/layout") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Layout />
      <Where />
    </MemoryRouter>,
  );

const sess = (id: string, cwd: string | null, at = 1): SessionSnapshot => ({
  ...createSnapshot({ session_id: id, host: "h", cwd: cwd ?? "", ts: 1 }),
  project_dir: cwd,
  last_event_at: at,
});
const put = (...l: SessionSnapshot[]) =>
  useBoard.setState({ sessions: Object.fromEntries(l.map((x) => [x.session_id, x])) });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  window.localStorage.clear();
  useLayout.setState({ spec: buildPreset("solo") });
  useBoard.setState({ sessions: {}, connection: "mock", loaded: false });
});

describe("Layout route (R6.1)", () => {
  it.each([
    ["solo", 2],
    ["pair", 2],
    ["quad", 4],
    ["focus", 4],
    ["grid6", 6],
    ["strip", 1],
  ] as const)("renders %s with %i panes", (name, n) => {
    useLayout.setState({ spec: buildPreset(name) });
    mount();
    expect(screen.getAllByTestId("pane")).toHaveLength(n);
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", name);
  });

  it("renders by-project from the projects it is given", () => {
    useLayout.setState({ spec: buildPreset("by-project", ["a", "b", "c"]) });
    mount();
    expect(screen.getAllByTestId("pane")).toHaveLength(3);
  });

  it("empty session panes say unassigned", () => {
    useLayout.setState({ spec: buildPreset("pair") });
    mount();
    expect(screen.getAllByText(/Unassigned/)).toHaveLength(2);
  });

  it("l opens the menu, arrows move, Enter applies a preset, Esc closes", async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard("l");
    const menu = screen.getByRole("menu", { name: "Layout presets" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(PRESET_NAMES.length);
    expect(screen.getByRole("menuitemradio", { name: /Solo/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(useLayout.getState().spec.id).toBe("pair");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getAllByTestId("pane")).toHaveLength(2);
    await user.keyboard("l{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("layout-menu-button")).toHaveFocus();
  });

  it("?preset applies once and is stripped from the URL", () => {
    mount("/layout?preset=quad");
    expect(useLayout.getState().spec.id).toBe("quad");
    expect(screen.getAllByTestId("pane")).toHaveLength(4);
    expect(screen.getByTestId("where").textContent).not.toContain("preset");
  });

  it("?preset=by-project waits, with feedback, until the first full set has loaded", () => {
    mount("/layout?preset=by-project");
    expect(useLayout.getState().spec.id).toBe("solo");
    expect(screen.getByTestId("where").textContent).toContain("preset=by-project");
    expect(screen.getByTestId("layout-waiting")).toHaveTextContent("Waiting for projects");
  });

  it("?preset=by-project applies once loaded, even with no sessions (one unassigned pane)", () => {
    mount("/layout?preset=by-project");
    act(() => useBoard.setState({ loaded: true }));
    expect(useLayout.getState().spec.id).toBe("by-project");
    expect(screen.getAllByTestId("pane")).toHaveLength(1);
    expect(screen.getByTestId("where").textContent).not.toContain("preset");
    expect(screen.queryByTestId("layout-waiting")).toBeNull();
  });

  it("by-project makes columns in attention order, a (no project) column, and +N more", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      sess(`s${i}`, `/w/p${String(i).padStart(2, "0")}`, 100 + i),
    );
    put(...many, sess("urgent", "/w/zeta", 1), { ...sess("np", null, 2) });
    useBoard.setState({ loaded: true });
    useBoard.setState((st) => ({
      sessions: {
        ...st.sessions,
        urgent: { ...st.sessions["urgent"]!, state: "waiting_permission" },
      },
    }));
    mount("/layout?preset=by-project");
    const dirs = panesOf(useLayout.getState().spec).map((p) => p.projectDir);
    expect(dirs).toHaveLength(12);
    expect(dirs[0]).toBe("/w/zeta");
    expect(screen.getByTestId("projects-more")).toHaveTextContent("+3 more projects");
  });

  it("+N more counts projects without a column even after the session set changed", () => {
    put(sess("a", "/w/a", 3), sess("b", "/w/b", 2));
    useBoard.setState({ loaded: true });
    mount("/layout?preset=by-project");
    expect(panesOf(useLayout.getState().spec).map((p) => p.projectDir)).toEqual(["/w/a", "/w/b"]);
    expect(screen.queryByTestId("projects-more")).toBeNull();
    // /w/a is gone, two new projects appear: columns {a, b}, projects {b, c, d}. Totals differ by 1.
    act(() => put(sess("b", "/w/b", 2), sess("c", "/w/c", 5), sess("d", "/w/d", 4)));
    expect(screen.getByTestId("projects-more")).toHaveTextContent("+2 more projects");
  });

  it("sessions without any project dir share one (no project) column", () => {
    put({ ...sess("a", null), cwd: "" }, { ...sess("b", null), cwd: "" });
    useBoard.setState({ loaded: true });
    mount("/layout?preset=by-project");
    expect(panesOf(useLayout.getState().spec).map((p) => p.projectDir)).toEqual(["(no project)"]);
    expect(screen.getAllByText("(no project)").length).toBeGreaterThan(0);
  });

  it("an unknown preset name is stripped and changes nothing", () => {
    mount("/layout?preset=nope");
    expect(useLayout.getState().spec.id).toBe("solo");
    expect(screen.getByTestId("where").textContent).not.toContain("preset");
  });

  it("the compact control toggles a pane and unmounts its body", async () => {
    const user = userEvent.setup();
    useLayout.setState({ spec: buildPreset("pair") });
    mount();
    expect(screen.getAllByText(/Unassigned. Assign/)).toHaveLength(2);
    const [first] = screen.getAllByRole("button", { name: /Compact Session pane/ });
    await user.click(first!);
    const pane = screen.getAllByTestId("pane")[0]!;
    expect(pane).toHaveAttribute("data-compact", "true");
    expect(within(pane).queryByText(/Unassigned. Assign/)).toBeNull();
    expect(within(pane).getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getAllByText(/Unassigned. Assign/)).toHaveLength(1);
    expect(
      useLayout.getState().spec.root.kind === "split" && JSON.stringify(useLayout.getState().spec),
    ).toContain('"compact":true');
    await act(async () => {});
  });
});
