/** The 17 hook events the probe registers on (docs/planning/01-architecture.md section 4.1). */
export const HOOK_EVENTS: readonly string[] = [
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
];

export const HOOK_TIMEOUT_SECONDS = 5;
export const STATUSLINE_REFRESH_SECONDS = 5;
/** Trailing argument that marks an entry as ours. The probe scripts ignore their argv. */
export const MARKER = "--sessiondeck-probe";
