// Synthetic payloads for hook events that were not captured (conductor decisions 7 and 3,
// 2026-10-15): TaskCreated, TaskCompleted, PermissionDenied, StopFailure.
//
// Field lists were verified against https://code.claude.com/docs/en/hooks on 2026-10-15 by
// sd-researcher. They are still not captured payloads: the common fields are copied from a scrubbed
// captured payload (placeholders only), the event-specific fields follow the documentation.
//
//   TaskCreated       task_id, task_subject, task_description, teammate_name, team_name (deprecated),
//                     optional agent_id (v2.1.290+). The doc example has no permission_mode. No matcher.
//   TaskCompleted     same fields; the doc example has permission_mode "default". A second variant
//                     carries agent_id and agent_type (task created by a subagent).
//   PermissionDenied  tool_name, tool_input, tool_use_id, reason; mcp_server for MCP tools only.
//                     Fires in auto mode only. Reason uses the documented "[Irreversible ...]" form.
//   StopFailure       error (12 documented values), error_details, last_assistant_message (the API
//                     error string, not Claude's output). No permission_mode in the doc example.
//                     Whether it carries agent_id is undocumented: main-session payload only.
import {
  PERMISSION_DENIED_REASON,
  STOP_FAILURE_DETAILS,
  STOP_FAILURE_MESSAGE,
} from "./fixture-synthetic-doc.mjs";

/** Common fields of a hook payload copied from the template. permission_mode is set per event. */
const COMMON_KEYS = [
  "session_id",
  "transcript_path",
  "cwd",
  "scratchpad_dir",
  "prompt_id",
  "effort",
];

const TASK_FIELDS = {
  task_id: "task001",
  task_subject: "<TEXT 24>",
  task_description: "<TEXT 80>",
  teammate_name: "<TEXT 8>",
  team_name: "<TEXT 8>",
};

/**
 * @param {Record<string, unknown>} template a scrubbed captured hook payload (e.g. UserPromptSubmit)
 * @returns {{ event: string, file: string, payload: Record<string, unknown> }[]} file is the name
 *   under synthetic/<event>/
 */
export function buildSynthetic(template) {
  /** @type {Record<string, unknown>} */
  const common = {};
  for (const k of COMMON_KEYS) if (Object.hasOwn(template, k)) common[k] = template[k];
  const make = (
    /** @type {string} */ event,
    /** @type {Record<string, unknown>} */ extra,
    file = "01-synthetic.json",
  ) => ({ event, file, payload: { ...common, ...extra, hook_event_name: event } });
  const withMode = (/** @type {string} */ mode, /** @type {Record<string, unknown>} */ rest) => ({
    permission_mode: mode,
    ...rest,
  });
  return [
    make("TaskCreated", { ...TASK_FIELDS }),
    make("TaskCompleted", withMode("default", { ...TASK_FIELDS })),
    make(
      "TaskCompleted",
      withMode("default", {
        ...TASK_FIELDS,
        agent_id: "a1b2c3d4e5f60718",
        agent_type: "general-purpose",
      }),
      "02-subagent.json",
    ),
    make(
      "PermissionDenied",
      withMode("auto", {
        tool_name: "Bash",
        tool_input: { command: "<TEXT 30>", description: "<TEXT 20>" },
        tool_use_id: "toolu_synthetic0000000000001",
        reason: PERMISSION_DENIED_REASON,
      }),
    ),
    make("StopFailure", {
      error: "rate_limit",
      error_details: STOP_FAILURE_DETAILS,
      last_assistant_message: STOP_FAILURE_MESSAGE,
    }),
  ];
}
