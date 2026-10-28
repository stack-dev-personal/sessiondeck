// Minimal archive-text redactor (R5.2): masks common secret shapes in the text fields of a vault
// capture before they leave the machine. Phase 4 (S7) redaction should absorb this module and
// share its rule data; until then this is the only guard on archive text.
//
// Every pattern is linear on hostile input: quantifiers are bounded or the match consumes what it
// scans, and callers cap the input (see MAX_REDACT_INPUT).

export const REDACTED = "[REDACTED]";

/** Longest text handed to the patterns; longer input is cut first (the payload caps are far lower). */
export const MAX_REDACT_INPUT = 64 * 1024;

// Keywords must end the identifier (`db_secret`, `apiKey`), so prose like "tokens: 1200" or
// "secretary: Bob" survives. PASS and PWD are short, so they must be the whole identifier or follow
// a `_`, `.` or `-` (`db_pass`), which keeps "bypass: x" and "compass: n" intact.
const LONG_KEYWORDS =
  "SECRET_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|CREDENTIALS?";
const SHORT_KEYWORDS = "PASS|PWD";

const SHAPES: RegExp[] = [
  // PEM private key blocks (an unterminated block is masked to the end of the text).
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // JWT-like: starts at the beginning of a base64url run so overlapping starts cannot rescan it.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
];

// scheme://user:password@host -> keep user and host, mask the password.
// The user may be empty (`redis://:pw@host`); the password runs to the LAST "@" before whitespace,
// so a password containing "@" or "/" is masked whole.
const URL_CRED = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{0,128}:)[^\s]{1,256}(?=@)/gi;

// Authorization header values of any scheme (Basic, Bearer, Token, ...): the rest of the line.
const AUTH_HEADER = /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?)[^\n"']+/gi;

const BEARER = /\b(Bearer)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;

// NAME=value (value is the rest of the line), NAME: value (one quoted string or token) and
// NAME:<newline><indent>value (YAML style). NAME may be quoted (JSON style).
const ENV_LINE = new RegExp(
  `(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]{0,64}(?:${LONG_KEYWORDS})|(?:[A-Za-z0-9_.-]{0,63}[_.-])?(?:${SHORT_KEYWORDS}))\\b["']?[ \\t]*)(=[ \\t]*[^\\n]+|:[ \\t]*(?:"[^"\\n]{0,512}"|'[^'\\n]{0,512}'|[^\\s]+)|:[ \\t]*\\r?\\n[ \\t]+[^\\s]+)`,
  "gi",
);

const NAME_SRC = `(?:[A-Za-z0-9_.-]{0,64}(?:${LONG_KEYWORDS})|(?:[A-Za-z0-9_.-]{0,63}[_.-])?(?:${SHORT_KEYWORDS}))`;

// `key: |` / `key: >-` header line (optionally a YAML list item or quoted key).
const BLOCK_HEAD = new RegExp(
  `^([ \\t]*(?:-[ \\t]+)?)(["']?${NAME_SRC}\\b["']?[ \\t]*:[ \\t]*(?:[!&][^\\s]*[ \\t]+)*)[|>][+-]?[0-9]?[ \\t]*(?:#.*)?\\r?$`,
  "i",
);

/** Masks YAML block/folded scalars under a secret key: the header keeps its key, the body is dropped. */
function maskBlockScalars(text: string): string {
  if (!/[|>][+-]?[0-9]?[ \t]*(?:#|\r?(?:\n|$))/.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = BLOCK_HEAD.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const keyIndent = (/^[ \t]*/.exec(line)?.[0] ?? "").length;
    out.push(`${m[1]}${m[2]}${REDACTED}${line.endsWith("\r") ? "\r" : ""}`);
    while (i + 1 < lines.length) {
      const next = lines[i + 1] as string;
      const blank = next.trim() === "";
      const indent = (/^[ \t]*/.exec(next)?.[0] ?? "").length;
      if (!blank && indent <= keyIndent) break;
      i++;
    }
  }
  return out.join("\n");
}

// CLI forms: `-u user:pass`, `--password value` / `--token=value`, and `PGPASSWORD value`
// (UPPERCASE env-like name with a prefix, then a space, then the value). A quoted value (ASCII,
// backtick or typographic quotes) swallows any text glued to its closing quote; an unclosed quote
// swallows the rest of the line. All alternatives are bounded and do not nest quantifiers.
const TAIL = "[^\\s]{0,512}";
const VALUE =
  `(?:"[^"\\n]{1,512}"${TAIL}|'[^'\\n]{1,512}'${TAIL}|\`[^\`\\n]{1,512}\`${TAIL}` +
  `|[\u201C\u201D][^\u201C\u201D\\n]{1,512}[\u201C\u201D]${TAIL}` +
  `|[\u2018\u2019][^\u2018\u2019\\n]{1,512}[\u2018\u2019]${TAIL}` +
  `|["'\`\u2018\u2019\u201C\u201D][^\\n]{0,512}|[^\\s]{1,512})`;
const CLI_USER = new RegExp(
  `(?<!\\S)(-u|--user)([ \\t]+)(?:["']?[^\\s:"']{1,128}:[^\\s]{1,512})`,
  "g",
);
const CLI_FLAG = new RegExp(
  `(?<!\\S)(--[a-z0-9-]{0,32}?(?:password|passwd|passphrase|token|secret|api-?key|credentials?)(?:-key)?)([ \\t]*=[ \\t]*|[ \\t]+)(?!-)${VALUE}`,
  "gi",
);
const UPPER_ENV = new RegExp(
  `(?<![A-Za-z0-9_.-])([A-Z0-9_]{1,64}(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY))([ \\t]+)(?![=:])(${VALUE})`,
  "g",
);

// A value that looks like `secret_name:` / `secret_name=...` may be the next assignment, but it may
// equally be a secret that happens to look like one (`Hunter2secret:`). Never keep it: it is masked
// together with the value that follows it, so nothing is left behind either way.
const NEXT_ASSIGN = new RegExp(`^["']?${NAME_SRC}\\b["']?[ \\t]*[=:]`, "i");
const BARE_NAME = new RegExp(`^${NAME_SRC}$`, "i");
const TAIL_VALUE = new RegExp(`^[ \\t]*(?:${VALUE})`);
const TAIL_AFTER_SEP = new RegExp(`^[ \\t]*[:=][ \\t]*(?:${VALUE})?`);
const QUOTE_CHARS = /["'`\u2018\u2019\u201C\u201D]/g;
const EOL = -1;

/**
 * How many chars after the matched value are still part of the secret (0 for an ordinary value),
 * or EOL when the rest of the line must go (the value names a secret and an `=` follows it).
 */
function extraSecretLength(v: string, rest: string): number {
  const core = v.replace(QUOTE_CHARS, "");
  const assign = NEXT_ASSIGN.exec(core);
  const next = assign !== null;
  if (!next && !BARE_NAME.test(core)) return 0;
  if (assign?.[0].endsWith("=")) return EOL; // `name=value`: ENV_LINE masked the rest of the line
  if (/^[ \t]*=/.test(rest)) return EOL;
  if (next) {
    if (!/:$/.test(core)) return 0;
    const t = TAIL_VALUE.exec(rest)?.[0] ?? "";
    return /=$/.test(t) ? EOL : t.length;
  }
  const t = TAIL_AFTER_SEP.exec(rest)?.[0] ?? ""; // `token :X`
  return /=$/.test(t) ? EOL : t.length;
}

function maskCli(
  s: string,
  re: RegExp,
  build: (m: RegExpExecArray) => { head: string; v: string },
): string {
  let out = "";
  let pos = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const { head, v } = build(m);
    const end = m.index + m[0].length;
    const extra = m[0].endsWith(REDACTED) ? 0 : extraSecretLength(v, s.slice(end, end + 1100));
    out += s.slice(pos, m.index) + head + REDACTED;
    if (extra === EOL) {
      const nl = s.indexOf("\n", end);
      pos = nl < 0 ? s.length : s[nl - 1] === "\r" ? nl - 1 : nl;
    } else pos = end + extra;
    re.lastIndex = pos;
  }
  return out + s.slice(pos);
}

/** Replaces secrets in text with [REDACTED]. Pure and total. */
export function redactText(text: string): string {
  let s = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text;
  for (const re of SHAPES) s = s.replace(re, REDACTED);
  s = s.replace(URL_CRED, (_m, pre: string) => `${pre}${REDACTED}`);
  s = s.replace(AUTH_HEADER, (_m, pre: string) => `${pre}${REDACTED}`);
  s = s.replace(BEARER, (_m, b: string, sp: string) => `${b}${sp}${REDACTED}`);
  s = maskBlockScalars(s);
  s = s.replace(CLI_USER, (_m, f: string, sp: string) => `${f}${sp}${REDACTED}`);
  s = maskCli(s, CLI_FLAG, (m) => ({
    head: `${m[1]}${m[2]}`,
    v: m[0].slice((m[1] as string).length + (m[2] as string).length),
  }));
  s = maskCli(s, UPPER_ENV, (m) => ({ head: `${m[1]}${m[2]}`, v: m[3] as string }));
  s = s.replace(ENV_LINE, (m: string, name: string, rest: string) => {
    const sep = rest[0] as string;
    const value = rest.slice(1).trim();
    if (value === REDACTED) return m;
    const gap = rest.includes("\n") ? " " : (/^[ \t]*/.exec(rest.slice(1))?.[0] ?? "");
    return `${name}${sep}${gap}${REDACTED}`;
  });
  return s;
}
