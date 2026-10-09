import type { SessionState } from "./state";

/** One rate-limit window. resets_at is epoch ms (converted from the payload's seconds). */
export interface Window {
  used_pct: number | null;
  resets_at: number | null;
}

export interface SubagentSnapshot {
  agent_id: string;
  agent_type: string;
  started_at: number;
  ended_at: number | null;
  tokens: number | null;
  context_window: number | null;
  model: string | null;
}

export interface SessionSnapshot {
  session_id: string;
  host: string;
  cwd: string;
  project_dir: string | null;
  session_name: string | null;
  model: { id: string; display_name: string } | null;
  effort: string | null;
  state: SessionState;
  state_since: number;
  state_detail: string | null;
  started_at: number;
  last_event_at: number;
  ended_reason: string | null;
  pid: number | null;
  context: {
    used_pct: number | null;
    window: number | null;
    input: number | null;
    output: number | null;
  };
  rate_limits: { five_hour: Window | null; seven_day: Window | null; captured_at: number | null };
  cost: {
    usd: number | null;
    duration_ms: number | null;
    lines_added: number | null;
    lines_removed: number | null;
  };
  subagents: SubagentSnapshot[];
  tasks: { total: number; completed: number; last_subject: string | null };
  git: {
    branch: string | null;
    worktree: string | null;
    pr: { number: number; url: string } | null;
  };
  last_assistant_message: string | null;
  last_prompt: string | null;
  prompt_cache: { warm: boolean; expires_at: number | null } | null;
  compactions: number;
}

export interface CreateSnapshotInput {
  session_id: string;
  host: string;
  cwd: string;
  /** Epoch ms of the first event. */
  ts: number;
}

/** Initial snapshot: state 'starting', nulls and zeros elsewhere. New object on every call. */
export function createSnapshot(input: CreateSnapshotInput): SessionSnapshot {
  return {
    session_id: input.session_id,
    host: input.host,
    cwd: input.cwd,
    project_dir: null,
    session_name: null,
    model: null,
    effort: null,
    state: "starting",
    state_since: input.ts,
    state_detail: null,
    started_at: input.ts,
    last_event_at: input.ts,
    ended_reason: null,
    pid: null,
    context: { used_pct: null, window: null, input: null, output: null },
    rate_limits: { five_hour: null, seven_day: null, captured_at: null },
    cost: { usd: null, duration_ms: null, lines_added: null, lines_removed: null },
    subagents: [],
    tasks: { total: 0, completed: 0, last_subject: null },
    git: { branch: null, worktree: null, pr: null },
    last_assistant_message: null,
    last_prompt: null,
    prompt_cache: null,
    compactions: 0,
  };
}
