// R5.4. Pure helpers for the FTS5 search index: what text a row contributes, and how a user query
// becomes a safe MATCH expression. Nothing here touches the database.
import { inferPhase } from "./infer.ts";

export interface SearchText {
  title: string;
  body: string;
}

const MAX_FIELD = 4000;
const squash = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The indexed text of one session snapshot. This is the single extension point for what a session
 * contributes to search: S9b adds archived harness captures as sessions with state = 'archived',
 * and any outcome text they carry in `outcome` (or `archive.outcome`) is indexed here already; a
 * later source of text (for example transcript excerpts) is added to this function, nothing else.
 */
export function indexSessionText(
  snapshot: Record<string, unknown>,
  sessionId: string,
  manualPhase: string | null,
): SearchText & { phase: string | null } {
  const git = (snapshot["git"] ?? null) as { branch?: unknown } | null;
  const branch = str(git?.branch);
  const name = str(snapshot["session_name"]);
  const phase = manualPhase !== null && manualPhase !== "" ? manualPhase : inferPhase(name, branch);
  const dir = str(snapshot["project_dir"]) || str(snapshot["cwd"]);
  const base = dir.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  const archive = (snapshot["archive"] ?? null) as { outcome?: unknown; title?: unknown } | null;
  const title = squash(name) || squash(str(archive?.title)) || base || sessionId.slice(0, 8);
  const body = [
    squash(str(snapshot["last_prompt"])),
    squash(str(snapshot["last_assistant_message"])),
    squash(str(snapshot["outcome"]) || str(archive?.outcome)),
    phase ?? "",
    branch,
    sessionId,
  ]
    .filter((x) => x !== "")
    .join("\n");
  return { title, body, phase };
}

export const MAX_QUERY_CHARS = 200;
const MAX_TOKENS = 8;
const MAX_TOKEN_CHARS = 64;
const MIN_PREFIX = 2;

/**
 * Tokens of a user query: runs of letters and digits (what the unicode61 tokenizer indexes).
 * Every other character, so quotes, parentheses, colons, `*`, `-`, `^` and the like, is a
 * separator and never reaches MATCH.
 */
export function queryTokens(q: string): string[] {
  return (q.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_CHARS));
}

/**
 * A safe FTS5 MATCH expression, or null when the query has no searchable token. Each token is a
 * quoted string (so NEAR, AND, OR, NOT and column names are plain words), all must match, and the
 * last one is a prefix (when at least 2 characters) so the palette works while typing.
 */
export function buildMatch(q: string): string | null {
  const t = queryTokens(q);
  // A one-character final token is dropped: the prefix index starts at 2 characters ("t"* would
  // walk every term starting with t), and as an exact word it would hide the results for one
  // keystroke ("fix t" returning nothing). Alone it yields no expression (the caller shows recent
  // items); after other tokens the earlier tokens still match ("fix"*).
  if (t.length > 1 && t[t.length - 1]!.length < MIN_PREFIX) t.pop();
  if (t.length === 1 && t[0]!.length < MIN_PREFIX) return null;
  if (t.length === 0) return null;
  return t
    .map((x, i) => `"${x}"${i === t.length - 1 && x.length >= MIN_PREFIX ? "*" : ""}`)
    .join(" ");
}
