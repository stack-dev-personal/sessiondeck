// Literal search for the transcript leak check (R0.7). A regex alternation over hundreds of folder
// names is far too slow on 12 MB, so each needle is found with indexOf on the lower-cased text and
// its neighbours are checked by hand. Returns counts only.

/** @typedef {"any" | "word" | "segment"} Mode
 *  any: substring; word: no letter or digit either side; segment: next to a path separator */

const isAlnum = (/** @type {number} */ c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSep = (/** @type {number} */ c) => c === 47 || c === 92;

/**
 * @param {string} hay lower-cased text
 * @param {string} needle lower-cased literal
 * @param {Mode} mode
 * @returns {number} occurrences
 */
export function countLiteral(hay, needle, mode) {
  if (needle === "") return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (mode === "any") {
      n += 1;
      continue;
    }
    const before = at === 0 ? -1 : hay.charCodeAt(at - 1);
    const end = at + needle.length;
    const after = end >= hay.length ? -1 : hay.charCodeAt(end);
    const wordOk = !isAlnum(before) && !isAlnum(after);
    if (mode === "word") {
      if (wordOk) n += 1;
    } else if ((isSep(before) && !isAlnum(after)) || (isSep(after) && !isAlnum(before))) {
      n += 1;
    }
  }
  return n;
}

/**
 * @param {string} text
 * @param {{ category: string, mode: Mode, needles: string[] }[]} groups
 * @returns {Map<string, number>} category -> occurrences
 */
export function searchGroups(text, groups) {
  const hay = text.toLowerCase();
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const g of groups) {
    for (const needle of g.needles) {
      const n = countLiteral(hay, needle.toLowerCase(), g.mode);
      if (n > 0) out.set(g.category, (out.get(g.category) ?? 0) + n);
    }
  }
  return out;
}
