/** Control characters (C0, DEL, C1) and the line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Text that came from a file (a state file can be edited) made safe to print: control characters,
 * which could move the cursor or fake extra lines, are replaced by "?".
 * @param {string} text
 * @returns {string}
 */
export function printable(text) {
  return text.replace(CONTROL_CHARACTERS, "?");
}
