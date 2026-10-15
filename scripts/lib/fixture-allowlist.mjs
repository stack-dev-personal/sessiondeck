// Default-deny allowlist for the fixture scrub (R0.7).
//
// A string value survives verbatim only when its normalized key path appears in KEEP and the value
// matches the listed pattern. Normalized path: object keys joined by ".", array elements as "[]"
// ("tasks[].status"). Numbers, booleans and null are always kept and never reach this table.
// Every other string becomes a placeholder (see fixture-scrub-core.mjs).

/** @typedef {{ re: RegExp, why: string }} KeepRule */

const ENUM = /^[a-z][a-z0-9_-]{1,39}$/;
const WORD = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const MODEL = /^[A-Za-z0-9._[\]-]{1,60}$/;

/** @type {Readonly<Record<string, KeepRule>>} */
export const KEEP = {
  hook_event_name: {
    re: /^[A-Za-z]{3,40}$/,
    why: "event discriminator the envelope and reducer switch on",
  },
  permission_mode: { re: WORD, why: "mode enum read by state rules" },
  source: { re: ENUM, why: "SessionStart source (startup, clear, compact, resume)" },
  reason: {
    re: ENUM,
    why: "SessionEnd reason enum (free-text reasons fall through to a placeholder)",
  },
  trigger: { re: /^(manual|auto)$/, why: "compaction trigger" },
  notification_type: { re: ENUM, why: "Notification discriminator" },
  model: { re: MODEL, why: "SessionStart model id" },
  "model.id": { re: MODEL, why: "statusLine model id" },
  "model.display_name": {
    re: /^[A-Za-z0-9._ ()[\]-]{1,60}$/,
    why: "statusLine model display name",
  },
  "tasks[].model": { re: MODEL, why: "subagentStatusLine row model" },
  version: { re: /^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.]+)?$/, why: "Claude Code version" },
  "output_style.name": { re: /^[A-Za-z0-9 _-]{1,40}$/, why: "output style name" },
  "effort.level": { re: ENUM, why: "effort level enum" },
  "tasks[].effort": { re: ENUM, why: "subagent effort enum" },
  "prompt_cache.ttl": { re: /^\d+[smhd]$/, why: "cache ttl such as 1h" },
  "background_tasks[].status": { re: ENUM, why: "task status enum" },
  "background_tasks[].type": { re: ENUM, why: "task type enum" },
  "tasks[].status": { re: ENUM, why: "subagent row status enum" },
  "tasks[].type": { re: ENUM, why: "subagent row type enum" },
  "tool_input.output_mode": { re: ENUM, why: "Grep output mode enum" },
  "tool_response.type": { re: ENUM, why: "response kind enum" },
  "tool_response.mode": { re: ENUM, why: "response mode enum" },
  "tool_response.status": { re: ENUM, why: "response status enum" },
  "tool_response.file.type": { re: ENUM, why: "Read result kind enum" },
  "tool_response[].type": { re: ENUM, why: "content block type" },
  "tool_response[].source.type": { re: ENUM, why: "image source type" },
  "tool_response[].source.media_type": { re: /^[a-z]+\/[a-z0-9.+-]+$/, why: "image media type" },
  "mcp_server.source": { re: ENUM, why: "MCP server origin enum (user, claudeai, dynamic)" },
  "prompt_cache.last_miss_cause.causes[]": { re: ENUM, why: "cache miss cause enum" },
  "tool_response.task_type": { re: ENUM, why: "background task type enum" },
  "workspace.repo.host": {
    re: /^(github\.com|gitlab\.com|bitbucket\.org)$/,
    why: "public git host",
  },
};

/**
 * Keys whose string values are paths; "file" means the last segment is a file name.
 * @type {Readonly<Record<string, "dir" | "file" | "auto">>}
 */
export const PATH_KEYS = {
  cwd: "dir",
  transcript_path: "file",
  agent_transcript_path: "file",
  scratchpad_dir: "dir",
  "workspace.current_dir": "dir",
  "workspace.project_dir": "dir",
  "workspace.added_dirs[]": "dir",
  "tasks[].cwd": "dir",
  "tool_input.file_path": "file",
  "tool_input.path": "auto",
  "tool_input.notebook_path": "file",
  "tool_response.filePath": "file",
  "tool_response.file.filePath": "file",
  "tool_response.outputFile": "file",
  "tool_response.persistedOutputPath": "file",
  "tool_response.filenames[]": "file",
  "tool_response.bashEditDiff.files[].filePath": "file",
  "tool_response.bashEditDiff.changedFiles[]": "file",
};

/** Keys holding session, agent, tool-use, prompt or task identifiers (remapped, shape kept). */
export const ID_KEYS = new Set([
  "session_id",
  "agent_id",
  "tool_use_id",
  "prompt_id",
  "background_tasks[].id",
  "tasks[].id",
  "tool_response.agentId",
  "tool_response.resumedAgentId",
  "tool_response.backgroundTaskId",
  "tool_response.taskId",
]);

/** Keys naming a custom or built-in agent type (built-ins stay, custom names are mapped). */
export const AGENT_KEYS = new Set([
  "agent_type",
  "agent.name",
  "tasks[].agentType",
  "tasks[].name",
  "background_tasks[].agent_type",
  "tool_input.subagent_type",
]);

/** Keys naming an MCP server. */
export const MCP_KEYS = new Set(["mcp_server", "mcp_server.name"]);

/** Keys that hold an account, org, repo owner or user id. */
export const ACCOUNT_KEY =
  /(^|\.)(account|organization|org|owner|user|username|login)(_?(id|uuid|name))?$/i;

/** Object keys whose child key names are user content (question text and the like). */
export const USER_KEYED = new Set(["answers", "annotations", "env", "headers", "variables"]);

export const BUILTIN_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "PowerShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Task",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "Skill",
  "SendMessage",
  "ToolSearch",
  "Monitor",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "SubagentHandback",
  "EnterWorktree",
  "ExitWorktree",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

export const BUILTIN_AGENTS = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
]);
