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
    expect(cost.querySelector('[data-source="transcript"]')).not.toBeNull();
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

describe("drawer provenance (R3.16)", () => {
  it("headless drawer shows labelled figures and subagent model, effort, tokens", () => {
    render(<DetailDrawer session={headless()} now={NOW} onClose={() => {}} />);
    const fig = document.querySelector('[data-section="context"]') as HTMLElement;
    expect(within(fig).getByText("API-equivalent")).toBeInTheDocument();
    expect(fig.textContent).toContain("94k tok");
    expect(fig.textContent).not.toMatch(/\d%/);
    expect(within(fig).getAllByText("from transcript").length).toBeGreaterThanOrEqual(3);
    const rows = document.querySelectorAll('[data-section="subagents"] tbody tr');
    expect(rows[0]).toHaveTextContent("claude-sonnet-5-5");
    expect(rows[0]).toHaveTextContent("medium");
    expect(rows[0]).toHaveTextContent("32k");
    expect(rows[0]?.querySelector('[data-source="transcript"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-source="transcript"]')).toBeNull();
    expect(rows[1]).toHaveTextContent("n/a");
  });

  it("statusline drawer has no transcript text", () => {
    render(<DetailDrawer session={statusline()} now={NOW} onClose={() => {}} />);
    expect(document.querySelector('[data-testid="detail-drawer"]')?.textContent).not.toContain(
      "from transcript",
    );
  });
});
