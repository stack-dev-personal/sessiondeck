import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { buildPreset, PRESET_NAMES, type PresetName } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { useBoard } from "../store/board";
import { HubError, memoryAdapter } from "../layout/saved";
import { useLayout } from "../store/layout";
import { useSaved } from "../store/saved";
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

describe("saved layouts and Shift+C on the route (R6.3, R6.5)", () => {
  const saved = (
    id: string,
    hotkey: number | null,
    host: string | null,
    preset = "quad" as const,
  ) => ({
    id,
    name: `Name ${id}`,
    hotkey,
    host,
    spec: { ...buildPreset(preset), id },
    updatedAt: 1,
  });
  beforeEach(() => {
    useSaved.setState({ rows: [], status: "ready", notice: null });
    useSaved.getState().setAdapter(memoryAdapter());
    useLayout.setState({ snapshot: null });
  });

  it("digits 1-9 switch to the slot's layout and the status line names it", async () => {
    useSaved.setState({ rows: [saved("a", 1, null), saved("b", 2, null, "pair")] });
    const user = userEvent.setup();
    mount();
    await user.keyboard("1");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "a");
    expect(screen.getAllByTestId("pane")).toHaveLength(4);
    expect(screen.getByTestId("layout-notice")).toHaveTextContent("Layout 1: Name a");
    await user.keyboard("2");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "b");
    expect(screen.getAllByTestId("pane")).toHaveLength(2);
    await user.keyboard("5");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "b");
    expect(screen.getByTestId("layout-notice")).toHaveTextContent("No layout in slot 5.");
  });

  it("uses the pin rule with the host of the board's most recent session", async () => {
    useSaved.setState({ rows: [saved("all", 1, null), saved("pin", 1, "h", "pair")] });
    put(sess("s", "/w/x"));
    const user = userEvent.setup();
    mount();
    await user.keyboard("1");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "pin");
  });

  it("does not fire while typing, with a modifier, or while a dialog is open", async () => {
    useSaved.setState({ rows: [saved("a", 1, null)] });
    const user = userEvent.setup();
    mount();
    await user.keyboard("s");
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    await user.keyboard("12");
    expect(name).toHaveValue("12");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "solo");
    // Focus on a button inside the dialog: still no layout keys.
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByTestId("save-dialog")).toBeNull();
    await user.keyboard("{Control>}1{/Control}");
    await user.keyboard("{Alt>}1{/Alt}");
    await user.keyboard("{Meta>}1{/Meta}");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "solo");
    await user.keyboard("1");
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout-id", "a");
  });

  it("s opens the save dialog, Enter saves with name, slot and pin, Esc closes", async () => {
    put(sess("s", "/w/x"));
    const user = userEvent.setup();
    mount();
    await user.keyboard("s");
    expect(screen.getByRole("dialog", { name: "Save layout" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Evening");
    await user.selectOptions(screen.getByRole("combobox", { name: "Hotkey slot" }), "3");
    await user.click(screen.getByRole("checkbox", { name: /Pin to host h/ }));
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.queryByTestId("save-dialog")).toBeNull());
    const row = useSaved.getState().rows[0]!;
    expect(row).toMatchObject({ name: "Evening", hotkey: 3, host: "h" });
    await user.keyboard("s{Escape}");
    expect(screen.queryByTestId("save-dialog")).toBeNull();
  });

  it("a hub error keeps the dialog open and shows the reason", async () => {
    useSaved.getState().setAdapter({
      list: () => Promise.resolve({ layouts: [] }),
      put: () => Promise.reject(new HubError(429)),
      remove: () => Promise.resolve(),
    });
    const user = userEvent.setup();
    mount();
    await user.keyboard("s");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "X{Enter}");
    expect(await screen.findByTestId("save-error")).toHaveTextContent(/Too many layout changes/);
    expect(screen.getByTestId("save-dialog")).toBeInTheDocument();
  });

  it("m lists saved layouts; rename, reassign and delete work from the keyboard", async () => {
    useSaved.getState().setAdapter(memoryAdapter({ layouts: [] }));
    await useSaved.getState().save({ name: "First", hotkey: null, host: null });
    const user = userEvent.setup();
    mount();
    await user.keyboard("m");
    const input = screen.getByRole("textbox", { name: "Name of First" });
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");
    await vi.waitFor(() => expect(useSaved.getState().rows[0]!.name).toBe("Renamed"));
    await user.selectOptions(screen.getByRole("combobox", { name: /Slot of/ }), "Slot 6");
    await vi.waitFor(() => expect(useSaved.getState().rows[0]!.hotkey).toBe(6));
    await user.click(screen.getByRole("button", { name: "Delete Renamed" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete Renamed" }));
    await vi.waitFor(() => expect(useSaved.getState().rows).toHaveLength(0));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("manage-dialog")).toBeNull();
  });

  it("Shift+C compacts every pane, again restores; lowercase c is not claimed by the route", async () => {
    useLayout.setState({ spec: buildPreset("quad") });
    const before = structuredClone(useLayout.getState().spec);
    const user = userEvent.setup();
    mount();
    await user.keyboard("{Shift>}C{/Shift}");
    expect(
      screen.getAllByTestId("pane").every((p) => p.getAttribute("data-compact") === "true"),
    ).toBe(true);
    expect(screen.getByTestId("compact-all")).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Shift>}C{/Shift}");
    expect(useLayout.getState().spec).toEqual(before);
    expect(screen.getAllByTestId("pane").some((p) => p.hasAttribute("data-compact"))).toBe(false);
    await user.keyboard("c");
    expect(useLayout.getState().spec).toEqual(before);
  });

  it("the layout notice keeps its box when empty", () => {
    mount();
    expect(screen.getByTestId("layout-notice")).toBeInTheDocument();
    expect(screen.getByTestId("layout-notice")).toHaveTextContent("");
  });
});
