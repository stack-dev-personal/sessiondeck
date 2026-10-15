// Synthetic payloads for hook events that were not captured (conductor decision 7, 2026-10-15):
// TaskCreated, TaskCompleted, PermissionDenied, StopFailure.
//
// Field lists: docs/research/2026-10-08-feasibility-and-oss.md names TaskCreated/TaskCompleted and
// the others only as "unverified at research time" and carries no field list, so the event-specific
// fields below come from the Claude Code hooks reference as recalled by the author (task_id,
// task_subject, task_description, teammate_name, team_name; tool_name, tool_input, tool_use_id,
// reason; error, error_details, last_assistant_message). They are UNVERIFIED against a real
// capture. The common fields are copied from a scrubbed captured payload, so they carry only
// placeholders.

/** Common fields of a hook payload that sd never reads from a template's event-specific part. */
const COMMON_KEYS = [
  "session_id",
  "transcript_path",
  "cwd",
  "scratchpad_dir",
  "prompt_id",
  "permission_mode",
  "effort",
];

/**
 * @param {Record<string, unknown>} template a scrubbed captured hook payload (e.g. UserPromptSubmit)
 * @returns {{ event: string, payload: Record<string, unknown> }[]}
 */
export function buildSynthetic(template) {
  /** @type {Record<string, unknown>} */
  const common = {};
  for (const k of COMMON_KEYS) if (Object.hasOwn(template, k)) common[k] = template[k];
  const make = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ extra) => ({
    event,
    payload: { ...common, hook_event_name: event, ...extra },
  });
  return [
    make("TaskCreated", {
      task_id: "task-synthetic-1",
      task_subject: "<TEXT 24>",
      task_description: "<TEXT 80>",
    }),
    make("TaskCompleted", {
      task_id: "task-synthetic-1",
      task_subject: "<TEXT 24>",
      task_description: "<TEXT 80>",
    }),
    make("PermissionDenied", {
      tool_name: "Bash",
      tool_input: { command: "<TEXT 30>", description: "<TEXT 20>" },
      tool_use_id: "toolu_synthetic0000000000001",
      reason: "<TEXT 60>",
    }),
    make("StopFailure", {
      error: "rate_limit",
      error_details: "<TEXT 40>",
      last_assistant_message: "<TEXT 50>",
    }),
  ];
}
