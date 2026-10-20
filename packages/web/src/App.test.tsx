import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useBoard } from "./store/board";
import { useUi } from "./store/ui";
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
    useUi.setState({ theme: "dark", compact: false });
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

  it("settings save to localStorage and survive a reload of the store", async () => {
    mount("/settings");
    await userEvent.type(screen.getByLabelText("Hub URL"), "http://hub:8787");
    await userEvent.click(screen.getByLabelText(/notifications/i));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    const stored = JSON.parse(window.localStorage.getItem("sd.settings")!);
    expect(stored).toMatchObject({ hubUrl: "http://hub:8787", notifications: true });
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
        .getAllByTestId("session-row")
        .find((r) => r.querySelector(`[data-state="${st}"]`))!;
      expect(row).toHaveTextContent(STATE_VOCAB[st].glyph);
      expect(row).toHaveTextContent(STATE_VOCAB[st].label);
    }
  });

  it("routes: / goes to board; /dev/cards renders the stub", () => {
    const { unmount } = mount("/");
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
    unmount();
    mount("/dev/cards");
    expect(screen.getByText("/dev/cards")).toBeInTheDocument();
  });
});
