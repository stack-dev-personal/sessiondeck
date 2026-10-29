import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, type Envelope, type SessionSnapshot } from "@sessiondeck/contract";
import { App } from "../App";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";
import { DRAWER_SECTIONS, DetailDrawer, sparklineLabel } from "./DetailDrawer";

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
    // A different density re-creates every card node under the open drawer.
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
    const items = Array.from(dlg.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]'));
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe("keys while the drawer is open", () => {
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

  it("switching the open session remounts the drawer (raw state reset, focus on close)", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.click(screen.getByRole("button", { name: /envelopes/ }));
    expect(screen.getByRole("button", { name: /envelopes/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    act(() => useUi.getState().openSession("b"));
    expect(screen.getByRole("dialog", { name: "name-b" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /envelopes/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();
  });

  it("removing the open session closes the drawer and focuses the card that was next to it", async () => {
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

  it("Esc closes only the drawer (board state untouched)", async () => {
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
  it("drawer content updates while open and focus stays put", async () => {
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

describe("content", () => {
  it("sections appear in the design-system order", async () => {
    mount();
    await userEvent.click(card("a"));
    const ids = Array.from(screen.getByRole("dialog").querySelectorAll("[data-section]")).map((n) =>
      n.getAttribute("data-section"),
    );
    expect(ids).toEqual([...DRAWER_SECTIONS]);
  });

  it("raw tail is collapsed by default and expands", async () => {
    useBoard.getState().enqueue(hook("a", "Stop", NOW));
    act(() => useBoard.getState().flush());
    mount();
    await userEvent.click(card("a"));
    const toggle = screen.getByRole("button", { name: /envelopes/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Envelope JSON")).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Envelope JSON")).toHaveTextContent('"hook_event_name": "Stop"');
  });

  it("empty and null data render n/a and empty-state text, not blanks", async () => {
    mount();
    await userEvent.click(card("a"));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByRole("img", { name: /n\/a/ })).toBeInTheDocument();
    expect(dlg).toHaveTextContent("No subagents in this session.");
    expect(dlg).toHaveTextContent("No tasks.");
    expect(dlg.querySelectorAll('[data-slot="reset"]')[0]).toHaveTextContent("n/a");
  });

  it("renders rate limits with countdowns, subagents, tasks, git and a safe PR link", () => {
    const s = snap("a", {
      rate_limits: {
        five_hour: { used_pct: 41, resets_at: NOW + 7_800_000 },
        seven_day: { used_pct: 63, resets_at: NOW + 3 * 86_400_000 },
        captured_at: NOW,
      },
      subagents: [
        {
          agent_id: "x",
          agent_type: "Explore",
          started_at: NOW - 120_000,
          ended_at: null,
          tokens: 12_000,
          context_window: 200_000,
          model: "haiku",
        },
      ],
      tasks: { total: 5, completed: 2, last_subject: "<b>ship</b>" },
      git: {
        branch: "feat/x",
        worktree: "wt1",
        pr: { number: 42, url: "https://example.com/pr/42" },
      },
      last_prompt: "do the thing",
      last_assistant_message: "<img src=x onerror=alert(1)>",
    });
    render(<DetailDrawer session={s} now={NOW} onClose={() => {}} />);
    const resets = Array.from(document.querySelectorAll('[data-slot="reset"]')).map(
      (n) => n.textContent,
    );
    expect(resets[0]).toBe("resets in 2h 10m");
    expect(resets[1]).toMatch(/^resets [A-Z][a-z]{2}$/);
    const row = screen.getByRole("row", { name: /Explore/ });
    expect(row).toHaveTextContent("12k");
    expect(row).toHaveTextContent("200k");
    expect(row).toHaveTextContent("haiku");
    expect(row).toHaveTextContent("2m");
    expect(screen.getByText("<b>ship</b>", { exact: false })).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "#42" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("href", "https://example.com/pr/42");
  });

  it("subagent Type carries a title and Model shows the short name with the full id in a title", () => {
    const s = snap("a", {
      subagents: [
        {
          agent_id: "x",
          agent_type: "general-purpose",
          started_at: NOW - 120_000,
          ended_at: null,
          tokens: 1,
          context_window: 2,
          model: "claude-sonnet-5-5",
          effort: "medium",
        },
      ],
    });
    render(<DetailDrawer session={s} now={NOW} onClose={() => {}} />);
    const row = screen.getByRole("row", { name: /general-purpose/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveAttribute("title", "general-purpose");
    expect(cells[3]).toHaveTextContent("Sonnet · medium");
    expect(cells[3]).not.toHaveTextContent("claude-sonnet-5-5");
    expect(cells[3]).toHaveAttribute("title", "claude-sonnet-5-5 · medium");
  });

  it("a stale window shows n/a for value and countdown; a javascript: PR url is not linked", () => {
    const s = snap("a", {
      rate_limits: {
        five_hour: { used_pct: 90, resets_at: NOW - 1000 },
        seven_day: null,
        captured_at: NOW,
      },
      git: { branch: null, worktree: null, pr: { number: 7, url: "javascript:alert(1)" } },
    });
    render(<DetailDrawer session={s} now={NOW} onClose={() => {}} />);
    const resets = Array.from(document.querySelectorAll('[data-slot="reset"]')).map(
      (n) => n.textContent,
    );
    expect(resets).toEqual(["n/a", "n/a"]);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("timeline lists transitions newest first with glyph and label", () => {
    const s = snap("a");
    render(
      <DetailDrawer
        session={s}
        now={NOW}
        onClose={() => {}}
        history={{
          samples: [],
          tail: [],
          transitions: [
            { state: "starting", detail: null, ts: NOW - 5000 },
            { state: "waiting_permission", detail: "tool:Bash", ts: NOW },
          ],
        }}
      />,
    );
    const items = document.querySelectorAll("[data-transition]");
    expect(items[0]).toHaveAttribute("data-transition", "waiting_permission");
    expect(items[0]).toHaveTextContent("▲");
    expect(items[0]).toHaveTextContent("Needs permission");
    expect(items[1]).toHaveTextContent("Starting");
  });
});

describe("sparkline label", () => {
  it("says n/a with no samples and summarizes min, max, latest otherwise", () => {
    expect(sparklineLabel([])).toContain("n/a");
    const l = sparklineLabel([
      { ts: 1, pct: 10 },
      { ts: 2, pct: 72.4 },
      { ts: 3, pct: 40 },
    ]);
    expect(l).toContain("min 10%");
    expect(l).toContain("max 72%");
    expect(l).toContain("latest 40%");
    expect(l).toContain("3 samples");
  });
});
