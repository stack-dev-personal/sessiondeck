// Private-content rules for the transcript scrub and its leak check (R0.7, security gate fix).
// Shared by both so the scrub and the gate cannot drift apart. Pure functions, no I/O.
//
//   1. an object whose path field points outside this project (the user-level Claude folder, another
//      repo, a temp folder) has its file contents, snippets, diffs and search patterns dropped
//   2. a tool_result whose tool_use read, searched or wrote such a path (or ran a shell command that
//      names one) has its output dropped, in the block and in the row's toolUseResult
//   3. hook output and skill listings in attachments are configuration, not conversation: dropped

/** Fields that name a file or directory next to the content they describe. */
export const PATH_SIBLINGS = [
  "path",
  "filename",
  "file_path",
  "filePath",
  "displayPath",
  "notebook_path",
];

/** Fields holding file contents or search terms; dropped when the sibling path is private. */
export const PRIVATE_CONTENT_KEYS = new Set([
  "content",
  "snippet",
  "oldString",
  "newString",
  "old_string",
  "new_string",
  "originalFile",
  "structuredPatch",
  "hunks",
  "patch",
  "diff",
  "pattern",
  "lines",
  "text",
]);

const PROJECT_A = /^<HOME>\/projects\/<PROJECT_A>(?:\/|$)/;
const ANY_ROOT = /^(?:<HOME>|<ROOT>)(?:\/|$)/;
/** A shell command naming the user-level folder, another home path, or the GitHub API for an account. */
const PRIVATE_COMMAND =
  /(?:~|\$HOME|<HOME>)\/\.claude\b|<HOME>\/(?!projects\/<PROJECT_A>)|\bgh\s+(?:api|repo)\b/;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"];

/**
 * Whether a placeholder-mapped path lies outside this project. Relative paths and values that were
 * not paths are not outside (they resolve inside the working directory).
 * @param {string} mapped
 */
export function isOutsideProject(mapped) {
  if (mapped.startsWith("~") || mapped.startsWith("$HOME")) return true;
  return ANY_ROOT.test(mapped) && !PROJECT_A.test(mapped);
}

/**
 * First path-valued sibling of an object, or undefined.
 * @param {Record<string, unknown>} obj
 * @returns {string | undefined}
 */
export function siblingPath(obj) {
  for (const k of PATH_SIBLINGS) {
    const v = obj[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/** @param {unknown} v whether a value carries anything worth dropping */
export const hasContent = (v) =>
  v !== null && typeof v !== "number" && typeof v !== "boolean" && v !== "";

const CUT_MARK = /<TRUNCATED \d+>$/;
const OWN_ROOT = "projects/<PROJECT_A>";
/** "<HOME>/" followed by a cut-off start of "projects/<PROJECT_A>" at the very end of the text. */
const CUT_HOME = new RegExp(
  `<HOME>/(?:${Array.from({ length: OWN_ROOT.length }, (_, n) => OWN_ROOT.slice(0, n)).join("|")})$`,
);

/**
 * A cut command can end inside this project's own root, which is not a private path. The scrub
 * judges whole commands; the leak check only sees the cut text, so it drops that dangling start.
 * @param {string} cmd
 */
const uncut = (cmd) => (CUT_MARK.test(cmd) ? cmd.replace(CUT_MARK, "").replace(CUT_HOME, "") : cmd);

/**
 * Whether a tool_use touches something outside this project. Takes scrubbed (placeholder) values.
 * @param {string} name tool name @param {unknown} input tool input with scrubbed strings
 */
export function isPrivateToolUse(name, input) {
  if (input === null || typeof input !== "object") return false;
  const inp = /** @type {Record<string, unknown>} */ (input);
  for (const k of PATH_INPUT_KEYS) {
    const v = inp[k];
    if (typeof v === "string" && isOutsideProject(v)) return true;
  }
  const cmd = inp.command;
  return SHELL_TOOLS.has(name) && typeof cmd === "string" && PRIVATE_COMMAND.test(uncut(cmd));
}

/** Attachment keys that carry hook output or listings of user configuration. */
const HOOK_OUTPUT_KEYS = ["stdout", "stderr", "content"];

/**
 * Keys of an attachment object that must be dropped, decided by its type and hook event.
 * @param {Record<string, unknown>} obj
 * @returns {ReadonlySet<string>}
 */
export function attachmentDropKeys(obj) {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type.startsWith("hook_") || typeof obj.hookEvent === "string") {
    return new Set(HOOK_OUTPUT_KEYS);
  }
  if (type === "skill_listing") return new Set(["content"]);
  return NONE;
}
const NONE = new Set();

/** Words that follow "MCP server" in ordinary prose and are not a server name. */
export const MCP_PROSE = new Set(
  (
    "is are was were has have had not no failed to that which or and but if for with in on at by " +
    "of the a an it its this these those name names tools tool instructions config configuration " +
    "list status connected connection disconnected error errors timeout timed responded response " +
    "needs need requires require returned returns output outputs entry entries block blocks " +
    "added removed none all any each every other another own side"
  ).split(" "),
);

const MCP_PHRASE = /\b(MCP servers?\s+["'`]?)([A-Za-z0-9][A-Za-z0-9_.:-]*)/gi;

/**
 * Replaces the name after "MCP server" with a placeholder from `map`.
 * @param {string} text @param {(name: string) => string} map
 */
export function mapMcpPhrase(text, map) {
  return text.replace(MCP_PHRASE, (m, lead, name) =>
    MCP_PROSE.has(name.toLowerCase()) ? m : `${lead}${map(name)}`,
  );
}

/**
 * Counts "MCP server <name>" phrases whose name is not a placeholder or a prose word.
 * @param {string} text
 */
export function countMcpNames(text) {
  let n = 0;
  for (const m of text.matchAll(MCP_PHRASE)) if (!MCP_PROSE.has((m[2] ?? "").toLowerCase())) n += 1;
  return n;
}
