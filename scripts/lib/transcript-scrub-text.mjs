// Free-text scrub for transcripts (R0.7, transcript extension): paths, tokens, emails and accounts
// are replaced inside any string, then the string is cut to FREE_MAX characters.
//
// Literals (user name, email addresses, account names, organization ids) are supplied by the caller,
// discovered at run time from the raw data and git config; nothing here names a real person.
import { FREE_MAX } from "./transcript-scrub-rules.mjs";
import { BUILTIN_TOOLS } from "./fixture-allowlist.mjs";
import { DENY_PLACEHOLDER } from "./transcript-deny-list.mjs";
import { cutPrivateText } from "./transcript-scrub-cuts.mjs";
import { mapMcpPhrase } from "./transcript-scrub-private.mjs";

const RUN = String.raw`[^\s"'\`<>|*?(){}\[\],;]*`;
const SEP = String.raw`(?:[\\/]|%5[Cc]|%2[Ff])`;
// A drive or home path may contain spaces ("My Documents"), and where a folder name ends is not
// knowable, so after the first space the match runs on to a quote, backtick, tab, newline or the
// end of the string. Over-cutting prose after a path is accepted; leaving a folder name is not.
const SPACE_TAIL = String.raw`(?:[ ][^"'\`\n\r\t<>|*?]*)?`;
const ABS_PATH = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9])[A-Za-z](?::|%3[Aa])${SEP}${RUN}${SPACE_TAIL}`,
    String.raw`(?<![A-Za-z0-9_.:/\\~$-])\/(?:(?:mnt\/)?[A-Za-z]\/)?(?:[Uu]sers|home)\/${RUN}${SPACE_TAIL}`,
    String.raw`(?<![A-Za-z0-9_.:/\\~$-])\/(?=[A-Za-z0-9._@-]+\/)${RUN}`,
    // no lookbehind: the folder name can be glued to the word before it once separators are lost
    String.raw`[A-Za-z]--Users-[A-Za-z0-9._-]+`,
    // a drive letter and a home folder with the separators lost ("C:Users<name>..."): nothing to keep
    String.raw`(?<![A-Za-z0-9])[A-Za-z]:(?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee])(?=[A-Za-z])${RUN}`,
  ].join("|"),
  "g",
);
const WORD_CHAR = /[A-Za-z0-9]/;
const ENCODED = /^[A-Za-z]--Users-/;
const PATH_TAIL = /(?::\d+){1,2}$|[.:!]+$/;

const TOKENS = [
  /\b(?:sk|ghp|gho|ghs|ghu)[-_][^\s'"`]+/g,
  /\b(?:npm|sbp|glpat|hf)_[A-Za-z0-9_-]{8,}/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g,
  /\bcf(?:ut|at|k)_[A-Za-z0-9]{20,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g,
];
const RUN_32 = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
const MCP_TOOL = /\bmcp__([A-Za-z0-9][A-Za-z0-9_.-]*?)__([A-Za-z0-9_-]+)/g;
// A name ending in a secret word, with or without a prefix (access_token, client_secret, X_API_KEY).
const SECRET_PAIR =
  /(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret|token|password|passwd|authorization|credentials?|private[_-]?key)s?["']?\s*[:=]\s*["']?)([^\s"',;<]{6,})/gi;
// Any assignment whose value is a long letters-and-digits run (24+) is a key, whatever the name.
const ASSIGNED_RUN =
  /(?<![A-Za-z0-9])([A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*["']?)([A-Za-z0-9]{24,})(?![A-Za-z0-9])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const GIT_OWNER =
  /\b((?:github\.com|gitlab\.com|bitbucket\.org)[:/]+|api\.github\.com\/(?:repos|users|orgs)\/)([A-Za-z0-9_.-]+)/gi;

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {string} s */
const mcpKey = (s) => s.toLowerCase().replace(/[\s_.:-]+/g, "_");

/**
 * A long run is a token when it mixes upper case, lower case and digits, or when it is one
 * unbroken lowercase-and-digits word (a path or a kebab name has separators and is not).
 */
const looksLikeSecret = (/** @type {string} */ run) =>
  (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run)) ||
  (/^[a-z0-9]+$/.test(run) && /[a-z]/.test(run) && /\d/.test(run));
const hasLetterAndDigit = (/** @type {string} */ run) => /[A-Za-z]/.test(run) && /\d/.test(run);

/**
 * @typedef {{ users?: string[], emails?: string[], accounts?: string[], fragments?: string[], folders?: string[], mcpServers?: string[], denyWords?: string[] }} Literals
 */

export class TextScrubber {
  /** @param {import("./fixture-scrub-paths.mjs").Mapper} mapper @param {Literals} [literals] */
  constructor(mapper, literals = {}) {
    this.mapper = mapper;
    const long = (/** @type {string[]|undefined} */ l) =>
      [...new Set(l ?? [])].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
    this.emails = long(literals.emails);
    this.accounts = long(literals.accounts);
    this.users = long(literals.users);
    /** @param {string[]} list @param {boolean} bounded */
    const sweep = (list, bounded) => {
      if (list.length === 0) return null;
      const alt = list.map(escapeRe).join("|");
      return new RegExp(bounded ? `(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])` : `(?:${alt})`, "gi");
    };
    this.emailRe = sweep(this.emails, true);
    this.accountRe = sweep(this.accounts, true);
    // The user name must not survive anywhere, so it is replaced inside longer words too.
    this.userRe = sweep(this.users, false);
    // Pieces of the account names (fix A): substrings, any case, inside longer words too.
    this.fragmentRe = sweep(long(literals.fragments), false);
    this.folderRe = sweep(long(literals.folders), true);
    // Local deny-list (raw/deny-words.txt): case-insensitive substrings, replaced by <DENY>.
    const deny = [...new Set((literals.denyWords ?? []).map((w) => w.toLowerCase()))]
      .filter((w) => w.length >= 3)
      .sort((a, b) => b.length - a.length);
    this.denyRe = sweep(deny, false);
    /** MCP server names by normalized key: "claude.ai Linear" and "claude_ai_Linear" are one server. */
    this.mcpKeys = new Map(
      (literals.mcpServers ?? []).filter((n) => n.length >= 3).map((n) => [mcpKey(n), n]),
    );
    const mcpAlt = [...this.mcpKeys.values()]
      .sort((a, b) => b.length - a.length)
      .map((n) =>
        n
          .split(/[\s_.:-]+/)
          .map(escapeRe)
          .join("[\\s_.:-]"),
      );
    this.mcpRe =
      mcpAlt.length === 0
        ? null
        : new RegExp(`(?<![A-Za-z0-9])(?:${mcpAlt.join("|")})(?![A-Za-z0-9])`, "gi");
    /** Number of fragment replacements made so far (reported by the run as a number only). */
    this.fragmentHits = 0;
  }

  /** @param {string} m */
  #absolute(m) {
    const t = PATH_TAIL.exec(m);
    const tail = t ? t[0] : "";
    const body = t ? m.slice(0, m.length - tail.length) : m;
    const decoded = body
      .replace(/%5[Cc]/g, "\\")
      .replace(/%2[Ff]/g, "/")
      .replace(/%3[Aa]/g, ":");
    if (ENCODED.test(decoded)) return `${this.mapper.mapEncodedFolder(decoded)}${tail}`;
    const norm = decoded
      .split("\\")
      .join("/")
      .replace(
        /^([A-Za-z]:\/+|\/+[A-Za-z]\/+|\/+)(users|home)(?=\/)/i,
        (_m, a, b) => `${a}${b.toLowerCase() === "users" ? "Users" : "home"}`,
      );
    return `${this.mapper.mapPath(norm, "auto") ?? "<PATH>"}${tail}`;
  }

  /**
   * Replaces paths, tokens, emails and accounts. Does not cut.
   * @param {string} input
   */
  scrub(input) {
    let s = cutPrivateText(input.replace(ABS_PATH, (m) => this.#absolute(m)));
    s = s.replace(MCP_TOOL, (m) => this.mapper.mapTool(m, BUILTIN_TOOLS));
    for (const re of TOKENS) s = s.replace(re, "<REDACTED>");
    s = s.replace(RUN_32, (run) => (looksLikeSecret(run) ? "<REDACTED>" : run));
    s = s.replace(SECRET_PAIR, "$1<REDACTED>");
    s = s.replace(ASSIGNED_RUN, (m, lead, run) =>
      hasLetterAndDigit(run) ? `${lead}<REDACTED>` : m,
    );
    s = mapMcpPhrase(s, (name) => this.mapper.mapMcp(this.mcpKeys.get(mcpKey(name)) ?? name));
    if (this.mcpRe) {
      s = s.replace(this.mcpRe, (m) => this.mapper.mapMcp(this.mcpKeys.get(mcpKey(m)) ?? m));
    }
    s = s.replace(GIT_OWNER, (m, host, owner) => (owner.startsWith("<") ? m : `${host}<ACCOUNT>`));
    if (this.emailRe) s = s.replace(this.emailRe, "<EMAIL>");
    s = s.replace(EMAIL, "<EMAIL>");
    if (this.accountRe) s = s.replace(this.accountRe, "<ACCOUNT>");
    if (this.userRe) s = this.#sweepWords(s, this.userRe);
    if (this.folderRe) s = s.replace(this.folderRe, "<DIR>");
    if (this.fragmentRe) s = this.#sweepWords(s, this.fragmentRe);
    if (this.denyRe) s = s.replace(this.denyRe, DENY_PLACEHOLDER);
    return s;
  }

  /**
   * Replaces every word (a run of letters and digits) that contains a match of `re` with
   * <ACCOUNT>. The whole word goes, so the letters around the placeholder cannot reveal which
   * piece was removed.
   * @param {string} s @param {RegExp} re global, case-insensitive substring pattern
   */
  #sweepWords(s, re) {
    /** @type {[number, number][]} */
    const spans = [];
    for (const m of s.matchAll(re)) {
      let from = m.index ?? 0;
      let to = from + m[0].length;
      while (from > 0 && WORD_CHAR.test(s[from - 1] ?? "")) from -= 1;
      while (to < s.length && WORD_CHAR.test(s[to] ?? "")) to += 1;
      const last = spans[spans.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else spans.push([from, to]);
    }
    if (spans.length === 0) return s;
    if (re === this.fragmentRe) this.fragmentHits += spans.length;
    let out = "";
    let at = 0;
    for (const [from, to] of spans) {
      out += `${s.slice(at, from)}<ACCOUNT>`;
      at = to;
    }
    return out + s.slice(at);
  }

  /** Whether a value contains a deny-list word (rejects enum-shaped values). @param {string} v */
  hasDenyWord(v) {
    if (!this.denyRe) return false;
    this.denyRe.lastIndex = 0;
    return this.denyRe.test(v);
  }

  /**
   * Free text: scrubbed, then cut to FREE_MAX characters plus "<TRUNCATED n>" (n = original length).
   * @param {string} input
   */
  free(input) {
    const s = this.scrub(input);
    if (input.length <= FREE_MAX && s.length <= FREE_MAX) return s;
    let end = FREE_MAX;
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never split a surrogate pair
    return `${s.slice(0, end)}<TRUNCATED ${input.length}>`;
  }
}
