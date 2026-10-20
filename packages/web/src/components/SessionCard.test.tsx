import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_STATES, createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { App } from "../App";
import { levelFor } from "../lib/format";
import { STATE_VOCAB } from "../lib/state-vocab";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";
import { CompactCard, SessionCard } from "./SessionCard";

const NOW = 1_800_000_000_000;

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ...createSnapshot({
      session_id: "s1",
      host: "stack-lap",
      cwd: "/w/bb2dash",
      ts: NOW - 720_000,
    }),
    ...over,
  };
}

function full(): SessionSnapshot {
  return snap({
    state: "working",
    state_detail: "tool:Edit",
    state_since: NOW - 720_000,
    session_name: "Validate harvest against catalog",
    model: { id: "claude-opus", display_name: "Claude Opus 4.7" },
    effort: "high",
    context: { used_pct: 72, window: 200_000, input: 144_000, output: 1000 },
    rate_limits: {
      five_hour: { used_pct: 41, resets_at: NOW + 7_800_000 },
      seven_day: { used_pct: 63, resets_at: NOW + 3 * 86_400_000 },
      captured_at: NOW,
    },
    cost: { usd: 1.84, duration_ms: 1, lines_added: 1, lines_removed: 1 },
    subagents: [
      {
        agent_id: "a",
        agent_type: "x",
        started_at: 1,
        ended_at: null,
        tokens: 1,
        context_window: 1,
        model: null,
      },
      {
        agent_id: "b",
        agent_type: "x",
        started_at: 1,
        ended_at: null,
        tokens: 1,
        context_window: 1,
        model: null,
      },
    ],
    tasks: { total: 7, completed: 3, last_subject: "t" },
    git: { branch: "feat/phase-3", worktree: null, pr: null },
    last_assistant_message: "Editing src/harvest/validate.ts",
  });
}

const rowsOf = (el: HTMLElement) =>
  [1, 2, 3, 4, 5, 6].map((n) => el.querySelector(`[data-row="${n}"]`)!);
const slotsOf = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("[data-slot]")).map((n) => n.getAttribute("data-slot"));

describe("SessionCard states", () => {
  it.each(SESSION_STATES)("%s renders glyph, label and state attribute", (st) => {
    render(<SessionCard s={snap({ state: st })} now={NOW} />);
    const card = screen.getByTestId("session-card");
    expect(card).toHaveAttribute("data-state", st);
    expect(card).toHaveTextContent(STATE_VOCAB[st].glyph);
    expect(card).toHaveTextContent(STATE_VOCAB[st].label);
    expect(card).toHaveAttribute("tabindex", "0");
    expect(card).toHaveAccessibleName(`bb2dash, ${STATE_VOCAB[st].label}`);
  });

  it("attention states ring, dimmed states dim, badges present", () => {
    const { rerender } = render(
      <SessionCard s={snap({ state: "waiting_permission" })} now={NOW} />,
    );
    expect(screen.getByTestId("session-card")).toHaveClass("sd-attention");
    expect(screen.getByTestId("session-card")).toHaveTextContent(/attention/i);
    rerender(<SessionCard s={snap({ state: "ended" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).toHaveClass("opacity-60");
    rerender(<SessionCard s={snap({ state: "exited" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).toHaveClass("opacity-60");
    expect(screen.getByTestId("session-card")).toHaveTextContent("no SessionEnd");
    rerender(<SessionCard s={snap({ state: "error" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).toHaveTextContent(/error/i);
    rerender(<SessionCard s={snap({ state: "idle" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).not.toHaveClass("sd-attention");
  });

  it("only the working dot pulses", () => {
    const { container, rerender } = render(
      <SessionCard s={snap({ state: "working" })} now={NOW} />,
    );
    expect(container.querySelectorAll(".sd-pulse")).toHaveLength(1);
    rerender(<SessionCard s={snap({ state: "idle" })} now={NOW} />);
    expect(container.querySelectorAll(".sd-pulse")).toHaveLength(0);
  });

  it("sits on surface-1", () => {
    render(<SessionCard s={snap()} now={NOW} />);
    expect(screen.getByTestId("session-card")).toHaveClass("bg-surface-1");
  });
});

describe("thresholds", () => {
  it("context boundaries 59/60/80/81", () => {
    expect([59, 60, 80, 81].map((p) => levelFor("context", p))).toEqual([
      "ok",
      "warn",
      "warn",
      "high",
    ]);
  });
  it("5h and 7d boundaries 59/60/85/86", () => {
    for (const k of ["five_hour", "seven_day"] as const) {
      expect([59, 60, 85, 86].map((p) => levelFor(k, p))).toEqual(["ok", "warn", "warn", "high"]);
    }
  });

  it.each([
    [59, "ok", "context 59 percent"],
    [60, "warn", "context 60 percent, warning"],
    [80, "warn", "context 80 percent, warning"],
    [81, "high", "context 81 percent, high"],
  ])("context %i renders level %s with aria text", (pct, level, aria) => {
    render(
      <SessionCard
        s={snap({ context: { used_pct: pct, window: 200_000, input: 1, output: 1 } })}
        now={NOW}
      />,
    );
    const m = document.querySelector('[data-meter="context"]')!;
    expect(m).toHaveAttribute("data-level", level);
    expect(m).toHaveAttribute("aria-label", aria);
    expect(m).toHaveTextContent(`${pct}%`);
  });

  it.each([
    [59, "ok"],
    [60, "warn"],
    [85, "warn"],
    [86, "high"],
  ])("5h %i renders %s and 7d too", (pct, level) => {
    const w = { used_pct: pct, resets_at: NOW + 1000 };
    render(
      <SessionCard
        s={snap({ rate_limits: { five_hour: w, seven_day: w, captured_at: NOW } })}
        now={NOW}
      />,
    );
    for (const k of ["five_hour", "seven_day"]) {
      const m = document.querySelector(`[data-meter="${k}"]`)!;
      expect(m).toHaveAttribute("data-level", level);
      expect(m).toHaveTextContent(`${pct}%`);
      if (level !== "ok")
        expect(m.getAttribute("aria-label")).toMatch(level === "warn" ? /warning/ : /high/);
    }
  });

  it("warn and high carry a text cue besides color", () => {
    render(
      <SessionCard
        s={snap({ context: { used_pct: 90, window: 200_000, input: 1, output: 1 } })}
        now={NOW}
      />,
    );
    expect(document.querySelector('[data-meter="context"] [data-slot="cue"]')).toHaveTextContent(
      "!!",
    );
  });
});

describe("nulls and layout stability", () => {
  it("all-null snapshot renders n/a for context, windows, cost, model, tasks", () => {
    render(<SessionCard s={snap()} now={NOW} />);
    for (const k of ["context", "five_hour", "seven_day"]) {
      const m = document.querySelector(`[data-meter="${k}"]`)!;
      expect(m).toHaveTextContent("n/a");
      expect(m).toHaveAttribute("data-level", "na");
      expect(m.querySelector('[data-slot="bar"]')).toBeInTheDocument();
    }
    expect(document.querySelector('[data-slot="cost"]')).toHaveTextContent("n/a");
    expect(document.querySelector('[data-slot="model"]')).toHaveTextContent("n/a");
    expect(document.querySelector('[data-slot="tasks"]')).toHaveTextContent("n/a");
    expect(document.querySelector('[data-slot="activity"]')).toHaveTextContent("n/a");
  });

  it("row structure, slots and fixed height are identical for null and populated", () => {
    const a = render(<SessionCard s={snap()} now={NOW} />);
    const cardA = a.getByTestId("session-card");
    const rowsA = rowsOf(cardA).map((r) => r.className);
    const slotsA = slotsOf(cardA);
    const styleA = cardA.getAttribute("style");
    const meterSlotsA = Array.from(cardA.querySelectorAll("[data-meter] [data-slot]")).map((n) =>
      n.className.replace(/(text|bg|border)-\S+/g, ""),
    );
    a.unmount();
    const b = render(<SessionCard s={full()} now={NOW} />);
    const cardB = b.getByTestId("session-card");
    expect(rowsOf(cardB).every(Boolean)).toBe(true);
    expect(rowsOf(cardB).map((r) => r.className)).toEqual(rowsA);
    const slotsB = slotsOf(cardB).filter((s) => s !== "dots-more");
    expect(slotsB.filter((s) => s !== "badge")).toEqual(slotsA.filter((s) => s !== "badge"));
    expect(cardB.getAttribute("style")).toBe(styleA);
    expect(styleA).toContain("height");
    const meterSlotsB = Array.from(cardB.querySelectorAll("[data-meter] [data-slot]")).map((n) =>
      n.className.replace(/(text|bg|border)-\S+/g, ""),
    );
    expect(meterSlotsB).toEqual(meterSlotsA);
  });

  it("populated card shows the design example values", () => {
    render(<SessionCard s={full()} now={NOW} />);
    const card = screen.getByTestId("session-card");
    expect(card).toHaveTextContent("72% of 200k");
    expect(card).toHaveTextContent("41%");
    expect(card).toHaveTextContent("63%");
    expect(card).toHaveTextContent("2 agents");
    expect(card).toHaveTextContent("3/7");
    expect(card).toHaveTextContent("$1.84");
    expect(card).toHaveTextContent("Opus·high");
    expect(card).toHaveTextContent("bb2dash · feat/phase-3");
    expect(card).toHaveTextContent("12m since prompt");
    expect(document.querySelector('[data-meter="five_hour"]')).toHaveAttribute(
      "title",
      "resets in 2h 10m",
    );
    expect(document.querySelector('[data-meter="seven_day"]')).toHaveAttribute(
      "title",
      expect.stringMatching(/^resets [A-Z][a-z]{2}$/),
    );
  });

  it("200k+ tag when input exceeds 200k tokens", () => {
    render(
      <SessionCard
        s={snap({ context: { used_pct: 30, window: 1_000_000, input: 250_000, output: 1 } })}
        now={NOW}
      />,
    );
    expect(document.querySelector('[data-meter="context"]')).toHaveTextContent("30% · 200k+");
  });

  it("12 subagents show 5 dots and +7", () => {
    const subagents = Array.from({ length: 12 }, (_, i) => ({
      agent_id: `a${i}`,
      agent_type: "x",
      started_at: 1,
      ended_at: null,
      tokens: null,
      context_window: null,
      model: null,
    }));
    render(<SessionCard s={snap({ subagents })} now={NOW} />);
    expect(document.querySelectorAll("[data-dot]")).toHaveLength(5);
    expect(document.querySelector('[data-slot="dots-more"]')).toHaveTextContent("+7");
    expect(document.querySelector('[data-slot="agents"]')).toHaveTextContent("12 agents");
  });

  it("long name truncates, never wraps", () => {
    render(<SessionCard s={snap({ session_name: "x".repeat(300) })} now={NOW} />);
    expect(document.querySelector('[data-slot="name"]')).toHaveClass("truncate");
    expect(document.querySelector('[data-row="2"]')).toHaveClass("whitespace-nowrap");
  });

  it("stale window (resets_at in the past) renders n/a, not the old number", () => {
    const rate_limits = {
      five_hour: { used_pct: 88, resets_at: NOW - 1 },
      seven_day: { used_pct: 50, resets_at: NOW + 1000 },
      captured_at: NOW - 10_000,
    };
    render(<SessionCard s={snap({ rate_limits })} now={NOW} />);
    const m = document.querySelector('[data-meter="five_hour"]')!;
    expect(m).toHaveTextContent("n/a");
    expect(m).not.toHaveTextContent("88");
    expect(m).toHaveAttribute("data-level", "na");
    expect(document.querySelector('[data-meter="seven_day"]')).toHaveTextContent("50%");
  });
});

describe("CompactCard", () => {
  it("one row with state, name, three numbers, agents and tasks; fixed height", () => {
    render(<CompactCard s={full()} now={NOW} />);
    const card = screen.getByTestId("session-card");
    expect(card).toHaveAttribute("data-density", "compact");
    expect(card.getAttribute("style")).toContain("--card-compact-h");
    expect(card).toHaveTextContent("Working");
    expect(card).toHaveTextContent("72%");
    expect(card).toHaveTextContent("41%");
    expect(card).toHaveTextContent("63%");
    expect(card).toHaveTextContent("2 agents");
    expect(card).toHaveTextContent("3/7");
    expect(within(card).getByLabelText("context 72 percent, warning")).toBeInTheDocument();
  });

  it("nulls render n/a and the same slots exist", () => {
    const a = render(<CompactCard s={snap()} now={NOW} />);
    const slotsA = slotsOf(a.getByTestId("session-card"));
    expect(a.getByTestId("session-card").textContent?.match(/n\/a/g)?.length).toBe(4);
    a.unmount();
    const b = render(<CompactCard s={full()} now={NOW} />);
    expect(slotsOf(b.getByTestId("session-card"))).toEqual(slotsA);
  });
});

describe("compact toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    useUi.setState({ compact: false });
    useBoard.setState({ sessions: { s1: full() }, connection: "mock" });
  });
  const mount = () =>
    render(
      <MemoryRouter initialEntries={["/board"]}>
        <App />
      </MemoryRouter>,
    );

  it("c toggles full and compact, header button reflects state, persists", async () => {
    const { unmount } = mount();
    expect(screen.getByTestId("session-card")).toHaveAttribute("data-density", "full");
    const btn = screen.getByRole("button", { name: /compact/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("c");
    expect(screen.getByTestId("session-card")).toHaveAttribute("data-density", "compact");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("sd.compact")).toBe("1");
    unmount();
    // remount with a fresh read of storage
    const raw = window.localStorage.getItem("sd.compact");
    useUi.setState({ compact: raw === "1" });
    mount();
    expect(screen.getByTestId("session-card")).toHaveAttribute("data-density", "compact");
  });

  it("held key (repeat) does not toggle twice", () => {
    mount();
    fireEvent.keyDown(window, { key: "c" });
    fireEvent.keyDown(window, { key: "c", repeat: true });
    expect(useUi.getState().compact).toBe(true);
  });

  it("localStorage throwing does not crash the toggle", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    mount();
    await userEvent.keyboard("c");
    expect(useUi.getState().compact).toBe(true);
    expect(screen.getByTestId("session-card")).toHaveAttribute("data-density", "compact");
  });
});
