import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPreset, PRESET_NAMES } from "../layout/presets";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";
import { Layout } from "./Layout";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mount = (url = "/layout") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Layout />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  window.localStorage.clear();
  useLayout.setState({ spec: buildPreset("solo") });
  useBoard.setState({ sessions: {}, connection: "mock" });
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

  it("?preset applies once and is stripped; by-project waits for projects", () => {
    mount("/layout?preset=quad");
    expect(useLayout.getState().spec.id).toBe("quad");
    expect(screen.getAllByTestId("pane")).toHaveLength(4);
  });

  it("the compact control toggles a pane and unmounts its body", async () => {
    const user = userEvent.setup();
    useLayout.setState({ spec: buildPreset("pair") });
    mount();
    const [first] = screen.getAllByRole("button", { name: /Compact Session pane/ });
    await user.click(first!);
    expect(screen.getAllByTestId("pane")[0]).toHaveAttribute("data-compact", "true");
    expect(
      useLayout.getState().spec.root.kind === "split" && JSON.stringify(useLayout.getState().spec),
    ).toContain('"compact":true');
    await act(async () => {});
  });
});
