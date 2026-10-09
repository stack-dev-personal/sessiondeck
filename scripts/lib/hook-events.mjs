/**
 * The 17 Claude Code hook events sessiondeck registers on (docs/planning/01-architecture.md).
 * Do not add events outside this list: WorktreeCreate, for one, replaces default git behavior.
 */
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
]);
