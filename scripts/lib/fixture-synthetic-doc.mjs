// Documentation example strings in the synthetic fixtures (R0.7, conductor decision 7).
//
// The four uncaptured hook events carry a few free-text fields. Their values are copied from the
// Claude Code hooks reference, so they are not user data and need not be placeholders. The leak gate
// accepts each one only in the named synthetic file, at the named key path, and only when the value
// is exactly the listed string. Captured directories get no such exception.
//
// Source of every entry: https://code.claude.com/docs/en/hooks, checked 2026-10-15 by sd-researcher.

export const HOOKS_DOC_URL = "https://code.claude.com/docs/en/hooks";
export const HOOKS_DOC_DATE = "2026-10-15";

export const PERMISSION_DENIED_REASON = "[Irreversible Local Destruction]";
export const STOP_FAILURE_DETAILS = "429 Too Many Requests";
export const STOP_FAILURE_MESSAGE = "API Error: Rate limit reached";

/**
 * @typedef {{ value: string, reason: string }} DocString
 * @type {Readonly<Record<string, Readonly<Record<string, DocString>>>>}
 * File (relative to the fixtures root, forward slashes) -> key path -> exact string.
 */
export const DOC_STRINGS = {
  "synthetic/PermissionDenied/01-synthetic.json": {
    reason: {
      value: PERMISSION_DENIED_REASON,
      reason: `documented PermissionDenied reason form, ${HOOKS_DOC_URL}`,
    },
  },
  "synthetic/StopFailure/01-synthetic.json": {
    error_details: {
      value: STOP_FAILURE_DETAILS,
      reason: `documented StopFailure error_details example, ${HOOKS_DOC_URL}`,
    },
    last_assistant_message: {
      value: STOP_FAILURE_MESSAGE,
      reason: `documented StopFailure API error string example, ${HOOKS_DOC_URL}`,
    },
  },
};

/**
 * The exact-string allowances for one fixture file, as key path -> value.
 * @param {string} relFile path relative to the fixtures root, forward slashes
 * @returns {Record<string, string>}
 */
export function docAllowFor(relFile) {
  const entry = Object.hasOwn(DOC_STRINGS, relFile) ? DOC_STRINGS[relFile] : undefined;
  return Object.fromEntries(Object.entries(entry ?? {}).map(([k, v]) => [k, v.value]));
}
