import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_STATES,
  createSnapshot,
  type Envelope,
  type SessionSnapshot,
} from "@sessiondeck/contract";
import { App } from "../App";
import { levelFor } from "../lib/format";
import { STATE_VOCAB } from "../lib/state-vocab";
import { statusLines } from "../mock/fixtures";
import { createBoardStore, useBoard } from "../store/board";
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
        parent_agent_id: null,
        parent_known: false,
      },
      {
        agent_id: "b",
        agent_type: "x",
        started_at: 1,
        ended_at: null,
        tokens: 1,
        context_window: 1,
        model: null,
        parent_agent_id: null,
        parent_known: false,
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
    expect(screen.getByTestId("session-card")).toHaveClass("sd-dim");
    rerender(<SessionCard s={snap({ state: "exited" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).toHaveClass("sd-dim");
    expect(screen.getByTestId("session-card")).toHaveTextContent("no SessionEnd");
    rerender(<SessionCard s={snap({ state: "error" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).toHaveTextContent(/error/i);
    rerender(<SessionCard s={snap({ state: "idle" })} now={NOW} />);
    expect(screen.getByTestId("session-card")).not.toHaveClass("sd-attention");
  });

  it("the arrival glow plays once per attention transition, not on re-insertion", () => {
    const glowEnd = (el: HTMLElement) => {
      // jsdom has no AnimationEvent: give a plain event the field React reads.
      const ev = Object.assign(new Event("animationend", { bubbles: true }), {
        animationName: "sd-glow",
      });
      act(() => {
        el.dispatchEvent(ev);
      });
    };
    const { rerender } = render(<SessionCard s={snap({ state: "working" })} now={NOW} />);
    const card = () => screen.getByTestId("session-card");
    expect(card()).not.toHaveClass("sd-arrive");
    rerender(<SessionCard s={snap({ state: "waiting_permission" })} now={NOW} />);
    expect(card()).toHaveClass("sd-arrive");
    glowEnd(card());
    expect(card()).not.toHaveClass("sd-arrive");
    // deltas while waiting, and moving the node in the DOM, do not replay it
    rerender(<SessionCard s={snap({ state: "waiting_permission", last_event_at: 5 })} now={NOW} />);
    const parent = card().parentElement!;
    parent.appendChild(card());
    expect(card()).not.toHaveClass("sd-arrive");
    // the other attention state is the same stay in attention
    rerender(<SessionCard s={snap({ state: "waiting_input" })} now={NOW} />);
    expect(card()).not.toHaveClass("sd-arrive");
    // leaving and entering again plays it again
    rerender(<SessionCard s={snap({ state: "working" })} now={NOW} />);
    rerender(<SessionCard s={snap({ state: "waiting_input" })} now={NOW} />);
    expect(card()).toHaveClass("sd-arrive");
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

describe("row 1 titles", () => {
  it("carry the full detail and where text", () => {
    render(
      <SessionCard s={snap({ state: "working", state_detail: "tool:ExitPlanMode" })} now={NOW} />,
    );
    const card = screen.getByTestId("session-card");
    expect(card.querySelector('[data-part="detail"]')).toHaveAttribute(
      "title",
      "tool:ExitPlanMode",
    );
    const where = card.querySelector('[data-slot="where"]')!;
    expect(where).toHaveAttribute("title", where.textContent ?? "");
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
    [59, "ok", "context 59 percent, of 200k"],
    [60, "warn", "context 60 percent, warning, of 200k"],
    [80, "warn", "context 80 percent, warning, of 200k"],
    [81, "high", "context 81 percent, high, of 200k"],
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

  it("cards carry no 5h or 7d meter (R3.12, they live in the UsageWidget)", () => {
    render(<SessionCard s={full()} now={NOW} />);
    expect(document.querySelector('[data-meter="five_hour"]')).toBeNull();
    expect(document.querySelector('[data-meter="seven_day"]')).toBeNull();
    expect(screen.getByTestId("session-card")).not.toHaveTextContent("41%");
    expect(screen.getByTestId("session-card")).not.toHaveTextContent("63%");
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
  it("all-null snapshot renders n/a for context, cost, model, tasks", () => {
    render(<SessionCard s={snap()} now={NOW} />);
    for (const k of ["context"]) {
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
    expect(card).toHaveTextContent("2 agents");
    expect(card).toHaveTextContent("3/7");
    expect(card).toHaveTextContent("$1.84");
    expect(card).toHaveTextContent("Opus·high");
    expect(card).toHaveTextContent("bb2dash · feat/phase-3");
    expect(card).toHaveTextContent("12m in state");
    expect(card).not.toHaveTextContent("since prompt");
  });

  it("200k+ tag comes from the payload flag, never from context.input", () => {
    const ctx = { used_pct: 30, window: 1_000_000, input: 250_000, output: 1 };
    const a = render(<SessionCard s={snap({ context: ctx })} now={NOW} exceeds200k={null} />);
    expect(document.querySelector('[data-meter="context"]')).not.toHaveTextContent("200k+");
    expect(document.querySelector('[data-meter="context"]')).toHaveTextContent("30% of 1M");
    a.unmount();
    render(
      <SessionCard s={snap({ context: { ...ctx, input: 0 } })} now={NOW} exceeds200k={true} />,
    );
    const m = document.querySelector('[data-meter="context"]')!;
    expect(m).toHaveTextContent("30% · 200k+");
    expect(m.getAttribute("aria-label")).toBe("context 30 percent, 200k+, of 1M");
  });

  it("aria label carries the window size when no tag", () => {
    render(
      <SessionCard
        s={snap({ context: { used_pct: 30, window: 200_000, input: 1, output: 1 } })}
        now={NOW}
      />,
    );
    expect(document.querySelector('[data-meter="context"]')).toHaveAttribute(
      "aria-label",
      "context 30 percent, of 200k",
    );
  });

  it("14-after-compact.json replayed through the store shows the 200k+ tag", () => {
    const store = createBoardStore((cb) => cb());
    const payload = statusLines.find(
      (p) => (p as { exceeds_200k_tokens?: boolean }).exceeds_200k_tokens,
    )!;
    expect(payload).toBeDefined();
    store.getState().enqueue({
      v: 1,
      host: "h",
      session_id: "s1",
      ts: NOW,
      kind: "statusline",
      payload,
    } as unknown as Envelope);
    store.getState().flush();
    const st = store.getState();
    expect(st.exceeds200k["s1"]).toBe(true);
    render(<SessionCard s={st.sessions["s1"]!} now={NOW} exceeds200k={st.exceeds200k["s1"]} />);
    expect(document.querySelector('[data-meter="context"]')).toHaveTextContent("200k+");
  });

  it("level uses the rounded number shown", () => {
    render(
      <SessionCard
        s={snap({ context: { used_pct: 59.6, window: 200_000, input: 1, output: 1 } })}
        now={NOW}
      />,
    );
    const m = document.querySelector('[data-meter="context"]')!;
    expect(m).toHaveTextContent("60%");
    expect(m).toHaveAttribute("data-level", "warn");
  });

  it("80.4 rounds to 80 and stays warn", () => {
    render(
      <SessionCard
        s={snap({ context: { used_pct: 80.4, window: 200_000, input: 1, output: 1 } })}
        now={NOW}
      />,
    );
    expect(document.querySelector('[data-meter="context"]')).toHaveAttribute("data-level", "warn");
  });

  it("footer says 'in state' for working too, never 'since prompt'", () => {
    render(<SessionCard s={snap({ state: "working", state_since: NOW - 240_000 })} now={NOW} />);
    expect(document.querySelector('[data-slot="elapsed"]')).toHaveTextContent("4m in state");
  });

  it("worktree shows after the branch when it differs from the project", () => {
    const a = render(
      <SessionCard s={snap({ git: { branch: "main", worktree: "wt-a", pr: null } })} now={NOW} />,
    );
    expect(screen.getByTestId("session-card")).toHaveTextContent("bb2dash · main (wt-a)");
    a.unmount();
    render(
      <SessionCard
        s={snap({ git: { branch: "main", worktree: "bb2dash", pr: null } })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("session-card")).not.toHaveTextContent("(bb2dash)");
  });

  it("dots: active first, then ended; [ended x5, active x2] shows the active ones", () => {
    const mk = (id: string, ended: boolean) => ({
      agent_id: id,
      agent_type: "x",
      started_at: 1,
      ended_at: ended ? 2 : null,
      tokens: null,
      context_window: null,
      model: null,
      parent_agent_id: null,
      parent_known: false,
    });
    const subagents = [
      ...[0, 1, 2, 3, 4].map((i) => mk(`e${i}`, true)),
      mk("a0", false),
      mk("a1", false),
    ];
    render(<SessionCard s={snap({ subagents })} now={NOW} />);
    const dots = Array.from(document.querySelectorAll("[data-dot]")).map((d) =>
      d.getAttribute("data-dot"),
    );
    expect(dots).toEqual(["active", "active", "ended", "ended", "ended"]);
    expect(document.querySelector('[data-slot="dots-more"]')).toHaveTextContent("+2");
    expect(document.querySelector('[data-slot="agents"]')).toHaveTextContent("2 agents");
  });

  it.each(["ended", "exited"] as const)(
    "%s card dims only surface and bars, never text opacity",
    (st) => {
      const rl = { used_pct: 50, resets_at: NOW + 1000 };
      const s = snap({
        state: st,
        context: { used_pct: 50, window: 200_000, input: 1, output: 1 },
        rate_limits: { five_hour: rl, seven_day: rl, captured_at: NOW },
      });
      for (const el of [
        <SessionCard key="f" s={s} now={NOW} />,
        <CompactCard key="c" s={s} now={NOW} />,
      ]) {
        const r = render(el);
        const card = screen.getByTestId("session-card");
        expect(card).toHaveClass("sd-dim");
        for (const n of [card, ...Array.from(card.querySelectorAll<HTMLElement>("*"))]) {
          expect(n.className).not.toMatch(/(^|\s)opacity-/);
          expect(n.style.opacity).toBe("");
        }
        r.unmount();
      }
    },
  );

  it("sd-dim css touches only background, border and bars", () => {
    const css = readFileSync(resolve(__dirname, "../styles/index.css"), "utf8");
    const block = css.match(/\.sd-dim[^{]*\{[^}]*\}/g)!.join("\n");
    const props = [...block.matchAll(/\.sd-dim([^{]*)\{([^}]*)\}/g)];
    for (const [, sel, body] of props) {
      if (/opacity/.test(body!)) expect(sel).toContain('[data-slot="bar"]');
      expect(body).not.toMatch(/(^|[;\s])color:/);
    }
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
      parent_agent_id: null,
      parent_known: false,
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
});

describe("CompactCard", () => {
  it("one row with state, name, context number, agents and tasks; fixed height", () => {
    render(<CompactCard s={full()} now={NOW} />);
    const card = screen.getByTestId("session-card");
    expect(card).toHaveAttribute("data-density", "compact");
    expect(card.getAttribute("style")).toContain("--card-compact-h");
    expect(card).toHaveTextContent("Working");
    expect(card).toHaveTextContent("72%");
    expect(card).not.toHaveTextContent("41%");
    expect(card).not.toHaveTextContent("63%");
    expect(card).toHaveTextContent("2 agents");
    expect(card).toHaveTextContent("3/7");
    expect(within(card).getByLabelText("context 72 percent, warning, of 200k")).toBeInTheDocument();
  });

  it("nulls render n/a and the same slots exist", () => {
    const a = render(<CompactCard s={snap()} now={NOW} />);
    const slotsA = slotsOf(a.getByTestId("session-card"));
    expect(a.getByTestId("session-card").textContent?.match(/n\/a/g)?.length).toBe(2);
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

describe("R3.2 row 1 truncation", () => {
  it("state detail and project/branch spans truncate and are separated by a gap", () => {
    const { container } = render(
      <SessionCard
        s={snap({
          state: "working",
          state_detail: "tool:ExitPlanMode",
          git: { branch: "feat/chart-widgets", worktree: "chart-wt", pr: null },
        })}
        now={NOW}
      />,
    );
    const row = container.querySelector('[data-row="1"]')!;
    const detail = row.querySelector('[data-part="detail"]')!;
    const where = row.querySelector('[data-slot="where"]')!;
    for (const el of [detail, where]) {
      expect(el.className).toMatch(/min-w-(0|\[10ch\])/);
      expect(el.className).toContain("truncate");
    }
    expect(row.className).toContain("gap-s-");
  });
});
