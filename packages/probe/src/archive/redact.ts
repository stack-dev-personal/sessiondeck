// Minimal archive-text redactor (R5.2): masks common secret shapes in the text fields of a vault
// capture before they leave the machine. Phase 4 (S7) redaction should absorb this module and
// share its rule data; until then this is the only guard on archive text.
//
// Every pattern is linear on hostile input: quantifiers are bounded or the match consumes what it
// scans, and callers cap the input (see MAX_REDACT_INPUT).

export const REDACTED = "[REDACTED]";

/** Longest text handed to the patterns; longer input is cut first (the payload caps are far lower). */
export const MAX_REDACT_INPUT = 64 * 1024;

const NAME_KEYWORDS = "SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL";

const SHAPES: RegExp[] = [
  // PEM private key blocks (an unterminated block is masked to the end of the text).
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // JWT-like: starts at the beginning of a base64url run so overlapping starts cannot rescan it.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
];

const BEARER = /\b(Bearer)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;

// NAME=value (value is the rest of the line) and NAME: value (value is one quoted string or token).
// NAME is any identifier containing a keyword, optionally quoted (JSON style).
const ENV_LINE = new RegExp(
  `((?:${NAME_KEYWORDS})[A-Za-z0-9_.-]{0,64}["']?[ \\t]*)(=[ \\t]*[^\\n]+|:[ \\t]*(?:"[^"\\n]{0,512}"|'[^'\\n]{0,512}'|[^\\s]+))`,
  "gi",
);

/** Replaces secrets in text with [REDACTED]. Pure and total. */
export function redactText(text: string): string {
  let s = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text;
  for (const re of SHAPES) s = s.replace(re, REDACTED);
  s = s.replace(BEARER, (_m, b: string, sp: string) => `${b}${sp}${REDACTED}`);
  s = s.replace(ENV_LINE, (m: string, name: string, rest: string) => {
    const sep = rest[0] as string;
    const value = rest.slice(1).trim();
    if (value === REDACTED) return m;
    const gap = /^[ \t]*/.exec(rest.slice(1))?.[0] ?? "";
    return `${name}${sep}${gap}${REDACTED}`;
  });
  return s;
}
