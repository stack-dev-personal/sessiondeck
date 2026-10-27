// Classification tables for the transcript scrub (R0.7, transcript extension). Default deny.
//
// A string value is classified by its normalized key path (object keys joined by ".", array
// elements as "[]", user-keyed names as "<key>"). Order of decisions, see transcript-scrub-core.mjs:
//   1. DROP_KEYS: the whole subtree becomes one "<BLOB n>" string (reason per key below)
//   2. SPECIAL path rules, then LEAF rules (structural, id, hash, account ...), each with a pattern;
//      a value that fails its pattern becomes "<TEXT n>"
//   3. inside a FREE_ROOTS subtree: free text (scrubbed, cut to 120 characters)
//   4. everywhere else: "<TEXT n>"

export const FREE_MAX = 120;

/** Keys whose whole subtree is replaced by "<BLOB n>" (n = JSON length), and why. */
export const DROP_KEYS = {
  wireToolInputs: "wire copy of every tool input sent to the API (bulk duplicate)",
  wireIngestContext: "wire copy of the ingested conversation context (bulk duplicate)",
  shape: "api-request-shape body: structure of the whole request (bulk duplicate)",
  toolInputCopies: "attachment copy of tool inputs (bulk duplicate)",
  serverClassifierRequest: "server-side classifier request reference (request body)",
  serverClassifierContext: "classifier context incl. git state, paths and remotes (request body)",
  systemPrompt: "system prompt text (configuration in bulk)",
  input_schema: "tool schema (configuration in bulk)",
  definition: "tool definition incl. schema and description (configuration in bulk)",
  entries: "deferred tool entries with schemas and descriptions (configuration in bulk)",
  surfacedDefinitions: "surfaced tool definitions (configuration in bulk)",
  hookAdditionalContext: "context injected by hooks (user configuration)",
  rawContent: "raw file contents duplicated beside the rendered copy",
  diagnostics: "request diagnostics (wire detail)",
  trackedFileBackups: "file-history backup map keyed by user file paths",
  backup: "file-history backup record (user file path and backup name)",
  tail: "api-request tail: hash list of the request body (wire payload)",
  schema: "tool schema in a tool listing (configuration in bulk)",
  base64: "base64 payload",
};

/** Keys whose value is the base64 payload of an image or document source (dropped when type is base64). */
export const BLOB_DATA_KEY = "data";

/** First path segments under which an unclassified string is free text (scrubbed, cut to FREE_MAX). */
export const FREE_ROOTS = new Set([
  "message",
  "toolUseResult",
  "attachment",
  "content",
  "lastPrompt",
  "aiTitle",
  "origin",
  "error",
  "errorDetails",
  "hookInfos",
  "hookErrors",
  "renderedInHumanTurn",
  "rendered",
  "summary",
  "prompt",
  "description",
  "compactMetadata",
]);

const ENUM = /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/;
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const MODEL = /^(?:<[a-z]{3,20}>|[A-Za-z0-9._[\]-]{1,60})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)?$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.]+)?$/;
const SLUG = /^[a-z]+(?:-[a-z]+){1,4}$/;

/** @typedef {{ kind: string, re?: RegExp, path?: "dir" | "file" | "auto", why: string, value?: string }} Rule */

/** @param {string} why @returns {Rule} */
const enumRule = (why) => ({ kind: "pattern", re: ENUM, why });
/** @param {string} why @returns {Rule} */
const idRule = (why) => ({ kind: "pattern", re: ID, why });

/** @type {Record<string, Rule>} keyed by leaf key; array elements carry a trailing "[]" */
export const LEAF = {};
/** @param {string[]} keys @param {Rule} rule */
const add = (keys, rule) => {
  for (const k of keys) LEAF[k] = rule;
};

add(
  [
    "type",
    "subtype",
    "level",
    "role",
    "stop_reason",
    "stopReason",
    "operation",
    "mode",
    "effort",
    "perTurnEffort",
    "thinkingDisplay",
    "permissionMode",
    "promptSource",
    "turnOrigin",
    "querySource",
    "userType",
    "entrypoint",
    "status",
    "rateLimitType",
    "overageStatus",
    "overageDisabledReason",
    "lowPriorityOffer",
    "decision",
    "reasonType",
    "ruleSource",
    "source",
    "kind",
    "producer",
    "toolDenialKind",
    "apiError",
    "commandMode",
    "hookEvent",
    "contextRendering",
    "reminderType",
    "action",
    "inference_geo",
    "service_tier",
    "speed",
    "trigger",
    "scope",
    "keep",
    "fromMode",
    "renderedRole",
    "queuePriority",
    "reason",
    "field",
    "baseline",
    "kinds",
    "bashFirstSteer",
    "errorCode",
    "code",
    "codeText",
    "platform",
    "clear_at",
    "clearAt",
    "requestShape",
    "atis",
    "upgradePaths[]",
    "path[]",
    "betas[]",
    "addedTypes[]",
    "removedTypes[]",
    "builtInTypes[]",
    "builtInPluginTypes[]",
    "causes[]",
    "stop_sequence",
    "recipient_kind",
  ],
  enumRule("closed-vocabulary enum the normalizer or reducer may switch on"),
);
add(
  [
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "leafUuid",
    "sessionId",
    "session_id",
    "promptId",
    "sourceToolAssistantUUID",
    "sourceToolUseID",
    "toolUseID",
    "toolUseId",
    "tool_use_id",
    "messageId",
    "snapshotMessageId",
    "interruptedMessageId",
    "agentId",
    "taskId",
    "backgroundTaskId",
    "id",
    "commandUuid",
    "source_uuid",
    "msg_id",
    "runId",
    "scheduledFireId",
    "scheduledTaskId",
    "senderTaskId",
    "reminderId",
    "requestRef",
    "base",
    "anchorUuid",
    "headUuid",
    "tailUuid",
    "allUuids[]",
    "uuids[]",
    "hopChain[]",
  ],
  idRule("identifier or link between rows (random, no personal data)"),
);
add(["requestId", "deliveryId", "delivery_id"], {
  kind: "const",
  re: ID,
  why: "Anthropic request or delivery id",
  value: "<REQUEST_ID>",
});
add(["hash", "shapeHash", "requestDigest", "digests[]", "blockHashes[]", "harnessSectionHash"], {
  kind: "const",
  why: "content digest (32+ character hex run)",
  value: "<REDACTED>",
});
add(["timestamp", "backupTime", "date"], { kind: "pattern", re: TIMESTAMP, why: "timestamp" });
add(["model", "requestedModel", "advisorModel", "resolvedModel", "modelId"], {
  kind: "pattern",
  re: MODEL,
  why: "model id",
});
add(["ttl"], { kind: "pattern", re: /^\d+[smhd]$/, why: "cache ttl such as 1h" });
add(["cron"], {
  kind: "pattern",
  re: /^[0-9*/,\s-]{5,40}$/,
  why: "cron expression (digits and cron punctuation only)",
});
add(["version"], { kind: "pattern", re: VERSION, why: "Claude Code version" });
add(["slug"], { kind: "pattern", re: SLUG, why: "random three-word session slug" });
add(["gitBranch", "branch"], {
  kind: "pattern",
  re: /^(?:main|p\d+[a-z]?\/[a-z0-9][a-z0-9-]{0,60}|sprint\/\d+-[a-z0-9][a-z0-9-]{0,60})$/,
  why: "this repo's public branch shapes only",
});
add(["userEmail", "email"], { kind: "const", value: "<EMAIL>", why: "account email" });
add(["organizationUuid", "accountUuid", "organizationName", "orgName", "owner"], {
  kind: "const",
  value: "<ACCOUNT>",
  why: "organization or account identity",
});
add(["prRepository"], { kind: "prRepository", why: "owner/repo of a pull request" });
add(["prUrl"], { kind: "prUrl", why: "pull request URL" });
add(["agentType", "subagent_type", "attributionAgent", "agentSetting"], {
  kind: "agent",
  why: "agent type (custom names numbered)",
});
add(["skill", "attributionSkill", "recipient", "to", "session_name"], {
  kind: "name",
  why: "user-chosen name, numbered",
});
add(["hookName"], {
  kind: "hookName",
  why: "hook name: <HookEventName> or <HookEventName>:<built-in tool> verbatim, else numbered",
});
add(
  [
    "tool_name",
    "tools[]",
    "toolsUsed[]",
    "matches[]",
    "names[]",
    "addedNames[]",
    "removedNames[]",
    "readdedNames[]",
    "surfacedNames[]",
    "wireHiddenNames[]",
    "preCompactDiscoveredTools[]",
  ],
  { kind: "tool", why: "tool name (built-ins verbatim, MCP tools numbered)" },
);
add(["needsAuthMcpServers[]", "pendingMcpServers[]"], {
  kind: "mcp",
  why: "MCP server name, numbered",
});
add(["cwd", "workingDirectory"], { kind: "path", path: "dir", why: "working directory" });
add(["scratchpad_dir", "scratchpadDirectory", "realParentDir", "additionalWorkingDirectories[]"], {
  kind: "path",
  path: "dir",
  why: "directory",
});
add(
  [
    "file_path",
    "filePath",
    "notebook_path",
    "filename",
    "displayPath",
    "planFilePath",
    "outputFile",
    "persistedOutputPath",
    "trackingPath",
    "filenames[]",
    "changedFiles[]",
  ],
  { kind: "path", path: "file", why: "file path" },
);
add(["path"], { kind: "path", path: "auto", why: "path" });

/**
 * Path-specific rules (checked before LEAF) for names whose meaning depends on the parent.
 * @type {Array<[RegExp, Rule]>}
 */
export const SPECIAL = [
  [/^message\.content\[\]\.name$/, { kind: "tool", why: "tool_use name" }],
  [/^message\.id$/, idRule("assistant message id (links streamed splits)")],
  [/^message\.model$/, { kind: "pattern", re: MODEL, why: "model id" }],
  [/\.failedMcpServers\[\]\.name$/, { kind: "mcp", why: "MCP server name, numbered" }],
  [/\.skills\[\]\.name$/, { kind: "name", why: "skill name, numbered" }],
  [/^origin\.(?:name|from)$/, { kind: "name", why: "sender name, numbered" }],
  [/^params\.thinking\.display$/, enumRule("thinking display enum")],
  [
    /^message\.input_transformations\[\]\.path$/,
    {
      kind: "pattern",
      re: /^[A-Za-z0-9_.[\]-]{1,60}$/,
      why: "request location such as a field path",
    },
  ],
  [/^cacheControl\[\]\.path\[\]$/, enumRule("cache control path element")],
  [/\.(?:cache_miss_reason|input_transformations\[\])\.type$/, enumRule("enum")],
  [/^(?:attachment|toolUseResult)\.(?:type|mode|status)$/, enumRule("enum")],
];

/** Object keys whose child key names are user content or model ids, never kept as key names. */
export const USER_KEYED = new Set([
  "answers",
  "annotations",
  "env",
  "headers",
  "variables",
  "trackedFileBackups",
]);
/** Object keys whose child key names are model ids: kept when they look like one. */
export const MODEL_KEYED = new Set(["modelUsage"]);

/** Reasons for the README, keyed by the class names the stats use. */
export const ENUM_RE = ENUM;
