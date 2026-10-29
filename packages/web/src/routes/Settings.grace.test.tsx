import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, useUi } from "../store/ui";
import { Settings } from "./Settings";

describe("grace setting (R3.10)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUi.setState({ settings: DEFAULT_SETTINGS });
  });
  afterEach(() => vi.restoreAllMocks());

  it("defaults to 120, changes, clamps, and persists", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    const input = screen.getByTestId("grace-setting") as HTMLInputElement;
    expect(input.value).toBe("120");
    await user.clear(input);
    await user.type(input, "99999");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(useUi.getState().settings.idleGraceSec).toBe(900);
    expect(JSON.parse(window.localStorage.getItem("sd.settings")!).idleGraceSec).toBe(900);
    await user.clear(input);
    await user.type(input, "0");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(loadSettings().idleGraceSec).toBe(0);
  });

  it("survives localStorage throwing on read and write", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadSettings().idleGraceSec).toBe(120);
    const user = userEvent.setup();
    render(<Settings />);
    const input = screen.getByTestId("grace-setting");
    await user.clear(input);
    await user.type(input, "30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(useUi.getState().settings.idleGraceSec).toBe(30);
  });

  it("clamps junk stored values on load", () => {
    window.localStorage.setItem("sd.settings", JSON.stringify({ idleGraceSec: -4 }));
    expect(loadSettings().idleGraceSec).toBe(0);
    window.localStorage.setItem("sd.settings", JSON.stringify({ idleGraceSec: "x" }));
    expect(loadSettings().idleGraceSec).toBe(120);
  });
});
