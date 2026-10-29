import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { DetailDrawer } from "./DetailDrawer";
import { SessionCard } from "./SessionCard";

const NOW = 1_800_000_000_000;

function headless(): SessionSnapshot {
  return {
    ...createSnapshot({ session_id: "h1", host: "stack-lap", cwd: "/w/x", ts: NOW - 60_000 }),
    state: "working",
    model: { id: "claude-opus-5-5", display_name: "claude-opus-5-5" },
    context: { used_pct: null, window: null, input: 94172, output: null },
    cost: { usd: 2.0868447, duration_ms: null, lines_added: null, lines_removed: null },
    git: { branch: "p1/hook-exe", worktree: null, pr: null },
    last_assistant_message: "Done.",
    subagents: [
      {
        agent_id: "a1",
        agent_type: "worker",
        started_at: NOW - 30_000,
        ended_at: null,
        tokens: 31959,
        context_window: null,
        model: "claude-sonnet-5-5",
        effort: "medium",
        figures_source: "transcript",
      },
      {
        agent_id: "a2",
        agent_type: "worker",
        started_at: NOW - 30_000,
        ended_at: null,
        tokens: 5000,
        context_window: 200_000,
        model: "claude-sonnet-5-5",
        figures_source: "subagent_statusline",
      },
    ],
    sources: {
      model: "transcript",
      context: "transcript",
      cost: "transcript",
      git_branch: "transcript",
      last_assistant_message: "transcript",
    },
  };
}

const statusline = (): SessionSnapshot => ({
  ...headless(),
  context: { used_pct: 40, window: 200_000, input: 80_000, output: 1 },
  sources: undefined,
  subagents: [],
});

describe("card provenance (R3.16)", () => {
  it("headless card: tokens only, API-equivalent cost, accessible transcript markers", () => {
    render(<SessionCard s={headless()} now={NOW} />);
    const ctx = screen.getByRole("group", { name: /context 94172 tokens.*from transcript/ });
    expect(ctx).toHaveTextContent("94k tok");
    expect(ctx).not.toHaveTextContent("%");
    const cost = screen.getByRole("group", { name: "API-equivalent cost $2.09, from transcript" });
    expect(cost).toHaveTextContent("$2.09");
    expect(cost).toHaveAttribute("title", "API-equivalent cost $2.09, from transcript");
    expect(document.querySelector('[data-slot="model"]')).toHaveAccessibleName(/from transcript/);
    expect(
      screen.getByText(/Enter opens details\. Cost, context.* are from transcript/),
    ).toBeInTheDocument();
  });

  it("statusline card: API-equivalent wording only, no markers", () => {
    render(<SessionCard s={statusline()} now={NOW} />);
    const cost = screen.getByRole("group", { name: "API-equivalent cost $2.09" });
    expect(cost.querySelector('[data-source="transcript"]')).toBeNull();
    expect(document.querySelector('[data-source="transcript"]')).toBeNull();
    expect(document.body.textContent).not.toContain("from transcript");
  });
});

describe("card provenance edge cases (R3.16)", () => {
  it("warning level shows the cue and the transcript glyph together", () => {
    const s = {
      ...headless(),
      context: { used_pct: 75, window: 200_000, input: 150_000, output: null },
    };
    render(<SessionCard s={s} now={NOW} />);
    const ctx = document.querySelector('[data-meter="context"]') as HTMLElement;
    expect(ctx.textContent).toContain("75%");
    expect(ctx.textContent).toContain("†");
    expect(ctx.textContent).toMatch(/[!▲]/);
  });

  it("branch marker is a sibling of the truncated text, so it cannot be clipped", () => {
    render(<SessionCard s={headless()} now={NOW} />);
    const where = document.querySelector('[data-slot="where"]') as HTMLElement;
    const mark = where.querySelector('[data-source="transcript"]') as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.className).toContain("shrink-0");
    expect(where.querySelector(":scope > .truncate")?.contains(mark)).toBe(false);
  });

  it("transcript cost source with null cost shows n/a, no source claim, not in the hint", () => {
    const s = {
      ...headless(),
      cost: { usd: null, duration_ms: null, lines_added: null, lines_removed: null },
    };
    render(<SessionCard s={s} now={NOW} />);
    const cost = document.querySelector('[data-slot="cost"]') as HTMLElement;
    expect(cost).toHaveAccessibleName("API-equivalent cost n/a");
    expect(cost.querySelector('[data-source="transcript"]')).toBeNull();
    expect(screen.getByText(/Enter opens details. Context.* from transcript/)).toBeInTheDocument();
  });
});

describe("drawer provenance (R3.16)", () => {
  it("headless drawer shows labelled figures and subagent model, effort, tokens", () => {
    render(<DetailDrawer session={headless()} now={NOW} onClose={() => {}} />);
    const fig = document.querySelector('[data-section="context"]') as HTMLElement;
    expect(within(fig).getByText("API-equivalent")).toBeInTheDocument();
    expect(fig.textContent).toContain("94k tok");
    expect(fig.textContent).not.toMatch(/\d%/);
    expect(within(fig).getAllByText("from transcript").length).toBeGreaterThanOrEqual(3);
    const rows = document.querySelectorAll('[data-section="subagents"] tbody tr');
    expect(rows[0]).toHaveTextContent("Sonnet");
    expect(rows[0]).toHaveTextContent("medium");
    expect(rows[0]).toHaveTextContent("32k");
    expect(rows[0]?.querySelector('[data-source="transcript"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-source="transcript"]')).toBeNull();
    expect(rows[1]).not.toHaveTextContent("medium");
    expect(rows[0]?.querySelector('[title="claude-sonnet-5-5 · medium"]')).not.toBeNull();
  });

  it("statusline drawer has no transcript text", () => {
    render(<DetailDrawer session={statusline()} now={NOW} onClose={() => {}} />);
    expect(document.querySelector('[data-testid="detail-drawer"]')?.textContent).not.toContain(
      "from transcript",
    );
  });
});
