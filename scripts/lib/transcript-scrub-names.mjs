// Names the transcript scrub must find in free text although they only appear in structured form in
// the raw rows (R0.7, security gate fix): MCP server names (tool names, server lists) and the names
// of repositories (GitHub URLs, API paths, gh loops). Values stay in memory; nothing is printed.

const MCP_TOOL = /\bmcp__([A-Za-z0-9][A-Za-z0-9_.-]*?)__/g;
const SERVER_LIST_KEYS = new Set(["needsAuthMcpServers", "pendingMcpServers", "failedMcpServers"]);
const MIN_NAME = 3;
const MAX_NAME = 80;
/** Not server names even when a test or a sentence put them in a tool name. */
const NOT_A_SERVER = new Set(["server", "other", "tools", "name", "mcp", "x", "s"]);

/**
 * MCP server names found in raw rows: from mcp__<server>__<tool> names and server-list fields.
 * @param {Iterable<unknown>} rows
 * @returns {string[]} sorted, unique
 */
export function deriveMcpServers(rows) {
  const out = new Set();
  /** @param {unknown} v @param {string} key */
  const walk = (v, key) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(MCP_TOOL)) if (m[1]) out.add(m[1]);
      if (SERVER_LIST_KEYS.has(key)) out.add(v);
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el, key);
    } else if (v !== null && typeof v === "object") {
      const o = /** @type {Record<string, unknown>} */ (v);
      if (SERVER_LIST_KEYS.has(key) && typeof o.name === "string") out.add(o.name);
      for (const [k, child] of Object.entries(o)) walk(child, k);
    }
  };
  for (const r of rows) walk(r, "");
  return [...out]
    .filter(
      (n) => n.length >= MIN_NAME && n.length <= MAX_NAME && !NOT_A_SERVER.has(n.toLowerCase()),
    )
    .sort();
}

const REPO_NAME = "[A-Za-z0-9][A-Za-z0-9_.-]{1,79}";
const REPO_PATTERNS = [
  new RegExp(
    `(?:github\\.com|gitlab\\.com|bitbucket\\.org)[:/]+[A-Za-z0-9_.-]+/(${REPO_NAME})`,
    "gi",
  ),
  new RegExp(`\\brepos/[A-Za-z0-9_.-]+/(${REPO_NAME})`, "gi"),
  new RegExp(`(?:--repo|\\s-R)[ =]+[A-Za-z0-9_.-]+/(${REPO_NAME})`, "gi"),
];
const GH_LOOP = /\bfor\s+\w+\s+in\s+([^;\n]{1,400});\s*do\b/g;
const SKIP_REPO = new Set(["actions", "pulls", "issues", "releases", "contents", "git", "commits"]);

/** @param {string} raw @returns {string} */
const cleanRepo = (raw) => raw.replace(/\.git$/i, "").replace(/[.-]+$/, "");

/**
 * Repository names in raw rows that are not public vocabulary.
 * @param {Iterable<unknown>} rows
 * @param {string} vocabulary lower-cased public text; a name found in it is public and kept
 * @param {Iterable<string>} [known] names already swept elsewhere (lower-cased on use)
 * @returns {string[]} sorted, unique
 */
export function deriveRepos(rows, vocabulary, known = []) {
  const found = new Set();
  const skip = new Set([...known].map((x) => x.toLowerCase()));
  /** @param {string} s */
  const scan = (s) => {
    if (!s.includes("/") && !s.includes(" in ")) return;
    for (const re of REPO_PATTERNS) {
      for (const m of s.matchAll(re)) if (m[1]) found.add(cleanRepo(m[1]));
    }
    if (/\bgh\b/.test(s)) {
      for (const m of s.matchAll(GH_LOOP)) {
        for (const w of (m[1] ?? "").split(/\s+/))
          if (/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(w)) found.add(w);
      }
    }
  };
  /** @param {unknown} v */
  const walk = (v) => {
    if (typeof v === "string") scan(v);
    else if (Array.isArray(v)) for (const el of v) walk(el);
    else if (v !== null && typeof v === "object") for (const c of Object.values(v)) walk(c);
  };
  for (const r of rows) walk(r);
  return [...found]
    .filter((n) => n.length >= MIN_NAME && n.length <= MAX_NAME)
    .filter((n) => !SKIP_REPO.has(n.toLowerCase()) && !skip.has(n.toLowerCase()))
    .filter((n) => !vocabulary.includes(n.toLowerCase()))
    .sort();
}
