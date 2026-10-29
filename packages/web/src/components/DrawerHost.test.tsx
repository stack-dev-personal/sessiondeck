import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, type Envelope, type SessionSnapshot } from "@sessiondeck/contract";
import { App } from "../App";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

const NOW = Date.now();

function snap(id: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: NOW - 60_000 }),
    state: "working",
    session_name: `name-${id}`,
    ...over,
  };
}

function hook(session: string, name: string, ts: number): Envelope {
  return {
    v: 1,
    id: "01HZX3K9QJ5V8M2N4P6R7S8T9W",
    kind: "hook",
    host: "h",
    os: "linux",
    session_id: session,
    hook_event_name: name,
    ts,
    seq: ts,
    payload: { session_id: session, cwd: "/w", hook_event_name: name },
  };
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/board"]}>
      <App />
    </MemoryRouter>,
  );
}

const card = (id: string) =>
  screen.getAllByTestId("session-card").find((c) => c.dataset["sessionId"] === id)!;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "dark");
  useUi.setState({ theme: "dark", compact: false, selectedSessionId: null });
  useBoard.setState({
    sessions: { a: snap("a"), b: snap("b"), c: snap("c") },
    exceeds200k: {},
    history: {},
    connection: "mock",
  });
});

describe("open and close", () => {
  it("Enter on a focused card opens the dialog and moves focus inside", async () => {
    mount();
    card("b").focus();
    await userEvent.keyboard("{Enter}");
    const dlg = screen.getByRole("dialog", { name: "name-b" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(useUi.getState().selectedSessionId).toBe("b");
    expect(dlg).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("main")).not.toHaveAttribute("inert");
    expect(document.querySelector("header")).not.toHaveAttribute("inert");
  });

  it("click opens; Esc closes and focus returns to that card", async () => {
    mount();
    await userEvent.click(card("c"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card("c")).toHaveFocus();
  });

  it("the close button closes and returns focus", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(card("a")).toHaveFocus();
  });

  it("returns focus to the card even after the board re-rendered (new node) while open", async () => {
    mount();
    card("b").focus();
    await userEvent.keyboard("{Enter}");
    const stale = card("b");
    // A different density re-creates every card node under the open popout.
    act(() => useUi.setState({ compact: true }));
    expect(card("b")).not.toBe(stale);
    await userEvent.keyboard("{Escape}");
    expect(card("b")).toHaveFocus();
    expect(card("b").dataset["density"]).toBe("compact");
  });

  it("opens from a compact row too", async () => {
    useUi.setState({ compact: true });
    mount();
    expect(card("a").dataset["density"]).toBe("compact");
    card("a").focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "name-a" })).toBeInTheDocument();
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    mount();
    await userEvent.click(card("a"));
    const dlg = screen.getByRole("dialog");
    const items = Array.from(
      dlg.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'),
    );
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe("keys while the popout is open", () => {
  it("with focus on body (clicked plain text), c and t do nothing and Tab stays inside", async () => {
    mount();
    await userEvent.click(card("a"));
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    await userEvent.keyboard("ct");
    expect(useUi.getState().compact).toBe(false);
    expect(useUi.getState().theme).toBe("dark");
    await userEvent.tab();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    (document.activeElement as HTMLElement).blur();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("header and main are inert while open and restored after close", async () => {
    mount();
    const main = document.querySelector("main")!;
    const header = document.querySelector("header")!;
    await userEvent.click(card("a"));
    expect(main).toHaveAttribute("inert");
    expect(header).toHaveAttribute("inert");
    await userEvent.keyboard("{Escape}");
    expect(main).not.toHaveAttribute("inert");
    expect(header).not.toHaveAttribute("inert");
  });

  it("switching the open session remounts the popout (focus on close)", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.tab();
    act(() => useUi.getState().openSession("b"));
    expect(screen.getByRole("dialog", { name: "name-b" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();
  });

  it("removing the open session closes the popout and focuses the card that was next to it", async () => {
    mount();
    await userEvent.click(card("b"));
    act(() => {
      useBoard.setState({ sessions: { a: snap("a"), c: snap("c") } });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUi.getState().selectedSessionId).toBeNull();
    expect(document.querySelector("main")).not.toHaveAttribute("inert");
    expect(document.querySelector("header")).not.toHaveAttribute("inert");
    expect(document.activeElement).toHaveAttribute("data-testid", "session-card");
    expect(document.activeElement).toHaveAttribute("data-session-id", "c");
  });

  it("removing the last card in order falls back to the previous one", async () => {
    mount();
    await userEvent.click(card("c"));
    act(() => {
      useBoard.setState({ sessions: { a: snap("a"), b: snap("b") } });
    });
    expect(document.activeElement).toHaveAttribute("data-session-id", "b");
  });

  it("cards announce the dialog and hint that Enter opens details", () => {
    mount();
    for (const c of screen.getAllByTestId("session-card")) {
      expect(c).toHaveAttribute("aria-haspopup", "dialog");
      expect(c).toHaveAccessibleDescription("Enter opens details");
    }
  });

  it("c, t, j, k typed inside do not toggle compact or theme or move cards", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.keyboard("ctjk");
    expect(useUi.getState().compact).toBe(false);
    expect(useUi.getState().theme).toBe("dark");
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("Esc closes only the popout (board state untouched)", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.keyboard("{Escape}");
    expect(useUi.getState().selectedSessionId).toBeNull();
    expect(screen.getAllByTestId("session-card")).toHaveLength(3);
  });
});

describe("j/k", () => {
  it("move focus in board order and clamp at both ends", async () => {
    mount();
    await userEvent.keyboard("j");
    expect(card("a")).toHaveFocus();
    await userEvent.keyboard("j");
    expect(card("b")).toHaveFocus();
    await userEvent.keyboard("jj");
    expect(card("c")).toHaveFocus();
    await userEvent.keyboard("k");
    expect(card("b")).toHaveFocus();
    await userEvent.keyboard("kk");
    expect(card("a")).toHaveFocus();
  });
});

describe("live updates", () => {
  it("popout content updates while open and focus stays put", async () => {
    mount();
    await userEvent.click(card("a"));
    const close = screen.getByRole("button", { name: /close/i });
    act(() => {
      const st = useBoard.getState();
      st.enqueue(hook("a", "Stop", NOW));
      st.flush();
    });
    expect(within(screen.getByRole("dialog")).getAllByText("Idle").length).toBeGreaterThan(0);
    expect(close).toHaveFocus();
  });
});
