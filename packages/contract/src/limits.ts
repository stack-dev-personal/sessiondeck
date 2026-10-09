/** Caps on text copied from hook payloads into the snapshot (UTF-16 code units, marker included). */
export const LAST_PROMPT_MAX_CHARS = 2000;
export const LAST_MESSAGE_MAX_CHARS = 2000;
export const STATE_DETAIL_MAX_CHARS = 120;
export const TOOL_NAME_MAX_CHARS = 120;

/** Visible end of every truncated text. */
export const TRUNCATION_MARKER = "...[truncated]";

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/** The text unchanged when it fits, else a prefix plus TRUNCATION_MARKER, at most `max` long in total. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return text.slice(0, Math.max(max, 0));
  let cut = max - TRUNCATION_MARKER.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) cut -= 1;
  return `${text.slice(0, cut)}${TRUNCATION_MARKER}`;
}
