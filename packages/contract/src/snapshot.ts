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
  /** Where tokens, model and context_window came from. Set by the hub; absent until filled. */
  figures_source?: "subagent_statusline" | "transcript";
}

/** Where a snapshot figure came from. */
export type FigureSource = "statusline" | "transcript";

export const FIGURE_SOURCES: readonly FigureSource[] = ["statusline", "transcript"];

export function isFigureSource(x: unknown): x is FigureSource {
  return typeof x === "string" && (FIGURE_SOURCES as readonly string[]).includes(x);
}

/**
 * Per-figure provenance. Absent key = not filled yet. Effort has no entry on purpose (decision 28:
 * measured figures only). Set by the hub, never by createSnapshot().
 */
export interface SnapshotSources {
  readonly model?: FigureSource;
  readonly context?: FigureSource;
  readonly cost?: FigureSource;
  readonly git_branch?: FigureSource;
  readonly last_assistant_message?: FigureSource;
}

/**
 * New sources object with key set to src. Statusline wins: an existing "statusline" entry is never
 * replaced by "transcript". Does not mutate its input.
 */
export function mergeSource(
  sources: SnapshotSources | undefined,
  key: keyof SnapshotSources,
  src: FigureSource,
): SnapshotSources {
  const current = sources?.[key];
  if (current === "statusline" && src === "transcript") return { ...sources };
  return { ...sources, [key]: src };
}

/**
 * Who holds the open permission prompt. The first shape names the asker (agent_id null: main
 * thread). The second is an explicit unknown: a Notification without agent_id announced the prompt
 * and it cannot say which context asked, so any context may leave waiting_permission.
 */
export type PermissionHolder =
  { tool: string | null; agent_id: string | null } | { tool: null; requester_unknown: true };

/** True for the explicit unknown-requester holder. */
export function isUnknownRequester(
  holder: PermissionHolder,
): holder is { tool: null; requester_unknown: true } {
  return "requester_unknown" in holder;
}

/**
 * Reducer bookkeeping, added in S0 beyond architecture 3.3 (confirm before S3 and S5). Logic reads
 * this, never state_detail. last_tool: last tool of a main-thread PreToolUse. permission: the open
 * permission prompt (tool null when only a Notification announced it); null whenever the state is
 * not waiting_permission. The hub stores this with the snapshot.
 */
export interface Tracking {
  last_tool: string | null;
  permission: PermissionHolder | null;
}

/** Fresh empty tracking. New object on every call. */
export function createTracking(): Tracking {
  return { last_tool: null, permission: null };
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
  /** expires_at is epoch ms. The payload sends epoch seconds; convert with epochSecondsToMs (statusline.ts). */
  prompt_cache: { warm: boolean; expires_at: number | null } | null;
  compactions: number;
  tracking: Tracking;
  /** Figure provenance, set by the hub (headless sessions). createSnapshot() omits it. */
  sources?: SnapshotSources;
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
    tracking: createTracking(),
  };
}
