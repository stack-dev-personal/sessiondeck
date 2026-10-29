import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useBoard } from "./store/board";
import { DEFAULT_SETTINGS, useUi } from "./store/ui";
import { STATE_VOCAB } from "./lib/state-vocab";
import { SESSION_STATES, createSnapshot } from "@sessiondeck/contract";

function mount(path = "/board") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
    useUi.setState({ theme: "dark", compact: false, settings: DEFAULT_SETTINGS });
    useBoard.setState({ sessions: {}, connection: "mock" });
  });

  it("t toggles theme on <html> and persists it", async () => {
    mount();
    await userEvent.keyboard("t");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("sd.theme")).toBe("light");
    await userEvent.keyboard("t");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("c toggles compact; keys typed into inputs are ignored", async () => {
    mount("/settings");
    await userEvent.type(screen.getByLabelText("Hub URL"), "tcc");
    expect(useUi.getState().compact).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByLabelText("Hub URL")).toHaveValue("tcc");
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("c");
    expect(useUi.getState().compact).toBe(true);
    expect(window.localStorage.getItem("sd.compact")).toBe("1");
  });

  it("ignores shortcuts with Ctrl held", async () => {
    mount();
    await userEvent.keyboard("{Control>}t{/Control}");
    expect(useUi.getState().theme).toBe("dark");
  });

  it("header shows mock connection and hosts derived from snapshots", () => {
    useBoard.setState({
      sessions: {
        a: createSnapshot({ session_id: "a", host: "zeta", cwd: "/p/a", ts: 1 }),
        b: createSnapshot({ session_id: "b", host: "alpha", cwd: "/p/b", ts: 1 }),
      },
    });
    mount();
    expect(screen.getByTestId("connection")).toHaveTextContent("mock");
    const hosts = screen.getByRole("list", { name: "Hosts" });
    expect(hosts.textContent).toBe("alphazeta");
  });

  it("header connection glyph is decorative, the word carries the status", () => {
    useBoard.setState({ connection: "open" });
    mount();
    const el = screen.getByTestId("connection");
    expect(el).toHaveTextContent("● connected");
    expect(el.querySelector("[aria-hidden='true']")?.textContent).toBe("●");
  });

  it("settings save to localStorage and survive a reload of the store", async () => {
    mount("/settings");
    await userEvent.type(screen.getByLabelText("Hub URL"), "http://hub:8787");
    await userEvent.click(screen.getByLabelText(/notifications/i));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/Saved/)).toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem("sd.settings")!);
    expect(stored).toMatchObject({ hubUrl: "http://hub:8787", notifications: true });
  });

  it("finding 2: the Viewer host is a setting, default none, saved with the rest", async () => {
    useBoard.setState({
      sessions: { s: createSnapshot({ session_id: "s", host: "lap", cwd: "/p", ts: 1 }) },
    });
    mount("/settings");
    const sel = screen.getByRole("combobox", { name: "Viewer host" });
    expect(sel).toHaveValue("");
    await userEvent.selectOptions(sel, "lap");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(JSON.parse(window.localStorage.getItem("sd.settings")!)).toMatchObject({
      viewerHost: "lap",
    });
  });

  it("every state renders glyph and word on the board", () => {
    const sessions = Object.fromEntries(
      SESSION_STATES.map((st, i) => [
        `s${i}`,
        { ...createSnapshot({ session_id: `s${i}`, host: "h", cwd: `/p/${i}`, ts: i }), state: st },
      ]),
    );
    useBoard.setState({ sessions });
    mount();
    for (const st of SESSION_STATES) {
      const row = screen
        .getAllByTestId("session-card")
        .find((r) => r.querySelector(`[data-state="${st}"]`))!;
      expect(row).toHaveTextContent(STATE_VOCAB[st].glyph);
      expect(row).toHaveTextContent(STATE_VOCAB[st].label);
    }
  });

  it("routes: / goes to board; /dev/cards renders the gallery", async () => {
    const { unmount } = mount("/");
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
    unmount();
    mount("/dev/cards");
    expect(await screen.findByTestId("dev-cards")).toBeInTheDocument();
  });
});

describe("shell keys and surfaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
    useUi.setState({ theme: "dark", compact: false });
    useBoard.setState({ sessions: {}, connection: "mock" });
  });

  it("auto-repeat keydown does not toggle again", async () => {
    mount();
    const press = (repeat: boolean) => fireEvent.keyDown(window, { key: "t", repeat });
    press(false);
    expect(useUi.getState().theme).toBe("light");
    press(true);
    expect(useUi.getState().theme).toBe("light");
  });

  it("board rows sit on surface-1 (state and faint text are measured there)", () => {
    useBoard.setState({
      sessions: { a: createSnapshot({ session_id: "a", host: "h", cwd: "/p/a", ts: 1 }) },
    });
    mount();
    expect(screen.getByTestId("session-card")).toHaveClass("bg-surface-1");
  });
});

describe("disconnect banner", () => {
  beforeEach(() => {
    useBoard.setState({ sessions: {}, connection: "mock", retryAt: null });
  });

  it("is absent when open or mock, shows icon and text when closed, and clears on open", () => {
    mount();
    const banner = screen.getByTestId("connection-banner");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toBeEmptyDOMElement();
    act(() => useBoard.getState().setConnection("closed", Date.now() + 4000));
    expect(banner).toHaveTextContent(/Disconnected, reconnecting in [1-4]s/);
    expect(banner).toHaveTextContent("✖");
    expect(screen.getByTestId("connection")).toHaveTextContent("disconnected");
    act(() => useBoard.getState().setConnection("connecting"));
    expect(banner).toHaveTextContent("Reconnecting");
    act(() => useBoard.getState().setConnection("open"));
    expect(banner).toBeEmptyDOMElement();
    expect(screen.getByTestId("connection")).toHaveTextContent("● connected");
  });

  it("takes no layout flow space (fixed overlay)", () => {
    mount();
    act(() => useBoard.getState().setConnection("closed", null));
    expect(screen.getByTestId("connection-banner").parentElement!.className).toContain("fixed");
  });
});
