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
