import { AGENT_ID_MAX_CHARS, truncate } from "./limits";
import { asRecord } from "./payload";
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
  /**
   * The agent that spawned this one; null when the main thread did (or when unknown, see
   * parent_known). Rows stored before this field existed read as null / false.
   */
  parent_agent_id: string | null;
  /** False when the reducer could not attribute the parent (no pending spawn, or spawns from more than one context). */
  parent_known: boolean;
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
  /**
   * Spawn requests seen (PreToolUse Agent or Task) and not yet matched by a SubagentStart, oldest
   * first; each entry is the spawning context's agent_id (null: main thread). Omitted when empty.
   * Capped at PENDING_SPAWNS_MAX.
   */
  pending_spawns?: (string | null)[];
  /**
   * How many of the oldest pending_spawns belong to an already-ambiguous set: those starts read
   * parent_known false. Omitted when zero.
   */
  ambiguous_remaining?: number;
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

/**
 * A subagent row with the parent fields filled in: rows stored before parent links existed read as
 * parent_agent_id null, parent_known false. Always a fresh object.
 */
export function readSubagentRow(row: unknown): SubagentSnapshot {
  const raw = asRecord(row);
  const parent = raw["parent_agent_id"];
  const id = typeof parent === "string" ? truncate(parent, AGENT_ID_MAX_CHARS) : null;
  return {
    ...raw,
    parent_agent_id: id,
    parent_known: raw["parent_known"] === true,
  } as unknown as SubagentSnapshot;
}
