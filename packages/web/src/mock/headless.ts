import { createSnapshot, type SessionSnapshot, type SubagentSnapshot } from "@sessiondeck/contract";

export const HEADLESS_SESSION_ID = "headless-mock-1";

/**
 * A headless `claude -p` session as the hub snapshots it after R2.12 and R2.13: no statusline, so
 * every figure is filled from the transcript and carries source "transcript". Context window is
 * null, so the board shows tokens only. Figures are the hub harness's (headless-harness.mjs).
 */
export function headlessSnapshot(now: number): SessionSnapshot {
  const sub = (id: string, tokens: number): SubagentSnapshot => ({
    agent_id: id,
    agent_type: "general-purpose",
    started_at: now - 600_000,
    ended_at: null,
    tokens,
    context_window: null,
    model: "claude-sonnet-5-5",
    effort: "medium",
    figures_source: "transcript",
  });
  return {
    ...createSnapshot({
      session_id: HEADLESS_SESSION_ID,
      host: "stack-lap",
      cwd: "/w/sessiondeck",
      ts: now - 1_800_000,
    }),
    project_dir: "/w/sessiondeck",
    session_name: "Headless run: verify hook exe",
    state: "working",
    state_since: now - 120_000,
    state_detail: "tool:Bash",
    last_event_at: now - 5_000,
    model: { id: "claude-opus-5-5", display_name: "claude-opus-5-5" },
    context: { used_pct: null, window: null, input: 94_172, output: null },
    cost: { usd: 2.0868447, duration_ms: null, lines_added: null, lines_removed: null },
    git: { branch: "p1/hook-exe", worktree: null, pr: null },
    last_assistant_message: "Running the hook exe install check.",
    last_prompt: "Verify the hook exe installs and reports.",
    subagents: [sub("headless-sub-1", 31_959), sub("headless-sub-2", 25_809)],
    sources: {
      model: "transcript",
      context: "transcript",
      cost: "transcript",
      git_branch: "transcript",
      last_assistant_message: "transcript",
    },
  };
}
