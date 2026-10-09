/** Session states derived by the hub from hook events (architecture 3.2). */
export const SESSION_STATES = [
  "starting",
  "working",
  "waiting_permission",
  "waiting_input",
  "idle",
  "error",
  "ended",
  "exited",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** The 17 hook events the probe registers on (architecture 4.1). Same list as scripts/lib/hook-events.mjs. */
export const HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const);

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Reason recorded on a session ended because a newer session_id took over its pid. */
export const SUPERSEDED_REASON = "superseded";

/**
 * What a transition row matches on. Every session state, plus `ended_superseded`: an `ended`
 * session whose ended_reason is `superseded`. That one is revivable by any later hook for the
 * session (a wrong or early supersede can be undone); a normal `ended` is not.
 */
export const ROW_STATES = [...SESSION_STATES, "ended_superseded"] as const;

export type RowState = (typeof ROW_STATES)[number];
