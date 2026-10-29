import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, type SessionSnapshot, type SubagentSnapshot } from "@sessiondeck/contract";
import { App } from "../App";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";
import { SessionPopout } from "./SessionPopout";

const NOW = Date.now();

function snap(id: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: NOW - 60_000 }),
    state: "working",
    session_name: `name-${id}`,
    ...over,
  };
}

const agent = (id: string, parent: string | null, known: boolean): SubagentSnapshot => ({
  agent_id: id,
  agent_type: `type-${id}`,
  started_at: NOW - 1000,
  ended_at: null,
  tokens: 1500,
  context_window: null,
  model: null,
  parent_agent_id: parent,
  parent_known: known,
});

function mount() {
  return render(
    <MemoryRouter initialEntries={["/board"]}>
      <App />
    </MemoryRouter>,
  );
}

const card = (id: string) =>
  screen.getAllByTestId("session-card").find((c) => c.dataset["sessionId"] === id)!;

const LINKED = [
  agent("l1", null, true),
  agent("l2", "l1", true),
  agent("l3", "l2", true),
  agent("u1", null, false),
];

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  useUi.setState({ theme: "dark", compact: false, selectedSessionId: null });
  useBoard.setState({
    sessions: { a: snap("a", { subagents: LINKED }), b: snap("b") },
    exceeds200k: {},
    history: {},
    connection: "mock",
  });
});

describe("dialog semantics and closing", () => {
  it("is a modal dialog labelled by its header, replacing the drawer on card click", async () => {
    mount();
    await userEvent.click(card("a"));
    const dlg = screen.getByRole("dialog", { name: "name-a" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByTestId("detail-drawer")).toBeNull();
    expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();
  });

  it("Esc closes and focus returns to the opening card", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card("a")).toHaveFocus();
  });

  it("backdrop click closes", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.click(screen.getByTestId("popout-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card("a")).toHaveFocus();
  });

  it("close button closes", async () => {
    mount();
    await userEvent.click(card("a"));
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("traps Tab and Shift+Tab", async () => {
    mount();
    await userEvent.click(card("a"));
    const dlg = screen.getByRole("dialog");
    const items = Array.from(
      dlg.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'),
    );
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1]!.focus();
    await userEvent.tab();
    expect(items[0]).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(items[items.length - 1]).toHaveFocus();
  });
});

describe("header and content slot", () => {
  it("shows reported fields and n/a for absent ones", () => {
    const s = snap("a", {
      model: { id: "m", display_name: "Opus 5" },
      effort: "high",
      cost: { usd: 1.5, duration_ms: null, lines_added: null, lines_removed: null },
      git: { branch: "feat/x", worktree: null, pr: null },
    });
    render(<SessionPopout session={s} onClose={() => {}} />);
    const slot = (n: string) => document.querySelector(`[data-slot="${n}"]`)!;
    expect(slot("model")).toHaveTextContent("Opus 5");
    expect(slot("effort")).toHaveTextContent("high");
    expect(slot("cost")).toHaveTextContent("API-equivalent");
    expect(slot("cost")).toHaveTextContent("$1.50");
    expect(slot("branch")).toHaveTextContent("feat/x");
    expect(slot("speed")).toHaveTextContent("n/a");
    render(<SessionPopout session={snap("z")} onClose={() => {}} />);
    expect(document.querySelectorAll('[data-slot="effort"]')[1]).toHaveTextContent("n/a");
  });

  it("renders contentSlot inside the content region", () => {
    render(
      <SessionPopout session={snap("a")} onClose={() => {}} contentSlot={<p>hello slot</p>} />,
    );
    expect(
      within(document.querySelector('[data-slot="content"]') as HTMLElement).getByText(
        "hello slot",
      ),
    ).toBeInTheDocument();
  });
});

describe("#session-<id> hash", () => {
  it("opening sets it, closing clears it", async () => {
    mount();
    await userEvent.click(card("a"));
    expect(window.location.hash).toBe("#session-a");
    await userEvent.keyboard("{Escape}");
    expect(window.location.hash).toBe("");
  });

  it("loading with the hash opens the popout", async () => {
    window.history.replaceState(null, "", "/#session-b");
    mount();
    expect(await screen.findByRole("dialog", { name: "name-b" })).toBeInTheDocument();
  });

  it("an unknown id opens nothing and does not crash", () => {
    window.history.replaceState(null, "", "/#session-nope");
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByTestId("session-card")).toHaveLength(2);
  });

  it("a hash for a session that arrives later opens then", async () => {
    window.history.replaceState(null, "", "/#session-late");
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      useBoard.setState({
        sessions: { ...useBoard.getState().sessions, late: snap("late") },
      });
    });
    expect(await screen.findByRole("dialog", { name: "name-late" })).toBeInTheDocument();
  });

  it("removing the hash (Back) closes", async () => {
    mount();
    await userEvent.click(card("a"));
    act(() => {
      window.history.replaceState(null, "", "/");
      fireEvent(window, new HashChangeEvent("hashchange"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("AgentRollup", () => {
  async function open() {
    mount();
    await userEvent.click(card("a"));
    return screen.getByTestId("agent-rollup");
  }
  const ids = (root: HTMLElement) =>
    within(root)
      .queryAllByTestId("agent-card")
      .map((c) => c.getAttribute("data-agent-id"));

  it("shows first level only; unlinked rows carry the marker", async () => {
    const root = await open();
    expect(ids(root)).toEqual(["l1", "u1"]);
    const u1 = within(root).getAllByTestId("agent-card")[1]!;
    expect(within(u1).getByText("unlinked")).toBeInTheDocument();
    const l1 = within(root).getAllByTestId("agent-card")[0]!;
    expect(within(l1).queryByText("unlinked")).toBeNull();
  });

  it("expands per node through three levels and collapses again", async () => {
    const root = await open();
    const toggle = () => within(root).getAllByTestId("agent-toggle");
    expect(toggle()[0]).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle()[0]!);
    expect(ids(root)).toEqual(["l1", "l2", "u1"]);
    await userEvent.click(toggle()[1]!);
    expect(ids(root)).toEqual(["l1", "l2", "l3", "u1"]);
    await userEvent.click(toggle()[0]!);
    expect(ids(root)).toEqual(["l1", "u1"]);
  });

  it("Expand all and Collapse all", async () => {
    const root = await open();
    await userEvent.click(within(root).getByRole("button", { name: "Expand all" }));
    expect(ids(root)).toEqual(["l1", "l2", "l3", "u1"]);
    await userEvent.click(within(root).getByRole("button", { name: "Collapse all" }));
    expect(ids(root)).toEqual(["l1", "u1"]);
  });

  it("cycle and missing-parent rows render without hanging", () => {
    const s = snap("a", {
      subagents: [
        agent("c1", "c2", true),
        agent("c2", "c1", true),
        agent("self", "self", true),
        agent("orphan", "ghost", true),
      ],
    });
    render(<SessionPopout session={s} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const shown = screen.getAllByTestId("agent-card").map((c) => c.getAttribute("data-agent-id"));
    expect(shown.sort()).toEqual(["c1", "c2", "orphan", "self"]);
    expect(screen.getAllByText("unlinked")).toHaveLength(3);
  });
});
