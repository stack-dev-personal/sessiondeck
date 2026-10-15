// Structural half of the leak gate (R0.7): an independent re-check of the scrubber's output.
//
// The gate does not trust that the scrub ran correctly. Every string and key name in a committed
// payload must be one of: empty, a placeholder the scrubber emits, a remapped id under an id key,
// a path placeholder under a path key, or a value that matches its KEEP rule. Every key name must
// be in fixture-keys.mjs or be a placeholder. Reports categories only, never the offending value.
import {
  ACCOUNT_KEY,
  AGENT_KEYS,
  BUILTIN_AGENTS,
  BUILTIN_TOOLS,
  ID_KEYS,
  MCP_KEYS,
  PATH_KEYS,
  USER_KEYED,
  keepRule,
} from "./fixture-allowlist.mjs";
import { KNOWN_KEYS, PLACEHOLDER_KEY } from "./fixture-keys.mjs";
import { isToken } from "./fixture-scrub-core.mjs";
import { STRUCT } from "./fixture-scrub-paths.mjs";

export const MAX_STRING = 200;
const GENERIC_PLACEHOLDER = /^<(?:TEXT \d+|REDACTED|EMAIL|ACCOUNT)>$/;
const TOOL_OK = /^(?:mcp__<MCP_\d+>__<TOOL_\d+>|<TOOL_\d+>)$/;
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_SHAPES = [
  new RegExp(`^${UUID_SRC}$`),
  /^toolu_[A-Za-z0-9]{6,60}$/,
  /^[0-9a-f]{8,40}$/,
  /^[A-Za-z0-9_-]{6,60}$/, // mapId output can be all letters
];
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEG = `(?:<PROJECT_[A-Z]\\d*>|<DIR_\\d+>|<FILE_\\d+>|${UUID_SRC}|agent-[0-9a-f]{8,40}|\\.{1,2}|${[...STRUCT].map(escape).join("|")})(?:\\.[A-Za-z0-9]{1,8})?`;
const PATH_PLACEHOLDER = new RegExp(`^(?:(?:<HOME>|<ROOT>)(?:/${SEG})*|${SEG}(?:/${SEG})*)$`);
const ID_LIKE_KEY = /id$/i;
/** Key names whose value must be a placeholder, at any depth (kept for the category name). */
const FREE_TEXT_KEYS = new Set([
  "prompt",
  "message",
  "last_assistant_message",
  "compact_summary",
  "error",
  "error_details",
  "description",
  "command",
  "content",
  "query",
  "plan",
  "stdout",
  "stderr",
  "summary",
  "label",
  "header",
  "question",
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "originalFile",
  "task_subject",
  "task_description",
  "session_name",
  "reason",
  "custom_instructions",
]);

/** @param {string} path */
const lastKey = (path) => path.split(".").pop()?.replace(/\[\]$/, "") ?? "";

/**
 * @param {string} v
 * @param {string} path normalized key path
 * @param {boolean} builtinTool payload's tool_name is a built-in tool
 * @returns {string | null} finding category, or null when the string is acceptable
 */
export function stringFinding(v, path, builtinTool) {
  if (v.length > MAX_STRING) return "string-over-200";
  if (v === "") return null;
  if (path === "tool_name") {
    return BUILTIN_TOOLS.has(v) || TOOL_OK.test(v) ? null : "string-not-allowlisted";
  }
  if (MCP_KEYS.has(path)) return /^<MCP_\d+>$/.test(v) ? null : "string-not-allowlisted";
  if (AGENT_KEYS.has(path)) {
    return BUILTIN_AGENTS.has(v) || /^<AGENT_\d+>$/.test(v) ? null : "string-not-allowlisted";
  }
  const deniedOk = GENERIC_PLACEHOLDER.test(v);
  if (ID_KEYS.has(path)) {
    return deniedOk || ID_SHAPES.some((re) => re.test(v)) ? null : "string-not-allowlisted";
  }
  if (Object.hasOwn(PATH_KEYS, path)) {
    return deniedOk || PATH_PLACEHOLDER.test(v) ? null : "string-not-allowlisted";
  }
  const rule = keepRule(path, builtinTool);
  if (rule?.re.test(v) === true && !isToken(v)) return null;
  if (deniedOk) return null;
  return FREE_TEXT_KEYS.has(lastKey(path)) ? "free-text-not-placeholder" : "string-not-allowlisted";
}

/**
 * Walks one parsed payload and calls hit(category) once per finding.
 * @param {unknown} doc
 * @param {(category: string) => void} hit
 */
export function checkStructure(doc, hit) {
  const builtinTool =
    doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? BUILTIN_TOOLS.has(String(/** @type {Record<string, unknown>} */ (doc).tool_name))
      : false;
  visit(doc, "", builtinTool, hit);
}

/** @param {unknown} v @param {string} path @param {boolean} builtin @param {(c: string) => void} hit */
function visit(v, path, builtin, hit) {
  if (typeof v === "string") {
    const category = stringFinding(v, path, builtin);
    if (category !== null) hit(category);
  } else if (typeof v === "number") {
    if ((ACCOUNT_KEY.test(path) || ID_LIKE_KEY.test(lastKey(path))) && v !== 0) hit("id-number");
  } else if (Array.isArray(v)) {
    for (const el of v) visit(el, `${path}[]`, builtin, hit);
  } else if (v !== null && typeof v === "object") {
    const userKeyed = USER_KEYED.has(lastKey(path));
    for (const [k, child] of Object.entries(v)) {
      if (k.length > MAX_STRING) hit("string-over-200");
      else if (!PLACEHOLDER_KEY.test(k) && (userKeyed || !KNOWN_KEYS.has(k))) hit("unknown-key");
      const seg = userKeyed || k.startsWith("<") ? "<key>" : k;
      visit(child, path === "" ? k : `${path}.${seg}`, builtin, hit);
    }
  }
}
