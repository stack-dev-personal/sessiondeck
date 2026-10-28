// MCP tool-name check of the transcript leak check (R0.7, security gate round 2). Counts every
// "mcp__..." name in a file's text that is not a placeholder; never returns a value.
//
// The scrub writes mcp__<MCP_n>__<TOOL_n> (or mcp__<MCP_n> for a server on its own). A name cut by
// the 120-character limit is a piece of that shape and passes; anything else names a real server.

/** A name token: up to a quote, backslash, whitespace or bracket. */
const TOKEN = /mcp__[^\s"'`\\,;)\]}]*/g;
const PLACEHOLDER = /^mcp__<MCP_\d+>(?:__<TOOL_\d+>)?(?![A-Za-z0-9_])/;
/** Documentation shape in prose: mcp__<server>__<tool>, possibly cut. */
const DOC_SHAPE = /^mcp__<[a-z_-]*>?(?:__<[a-z_-]*>?)?$/;
/** The longest placeholder, digits collapsed, for prefix tests of a cut name. */
const FULL_SHAPE = "mcp__<MCP_0>__<TOOL_0>";

/** @param {string} token */
function isPlaceholderName(token) {
  const name = token.split("<TRUNCATED")[0] ?? "";
  if (PLACEHOLDER.test(name) || DOC_SHAPE.test(name)) return true;
  return FULL_SHAPE.startsWith(name.replace(/\d+/g, "0"));
}

/**
 * @param {string} text the whole file
 * @returns {number} count of mcp__ names that are not placeholders
 */
export function countUnmappedMcpNames(text) {
  let n = 0;
  for (const m of text.matchAll(TOKEN)) if (!isPlaceholderName(m[0])) n += 1;
  return n;
}
