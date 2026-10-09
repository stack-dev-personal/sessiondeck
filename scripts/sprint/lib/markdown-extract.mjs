// Pulls sections, fenced blocks, and sprint package blocks out of the two markdown inputs.
// Pure functions over strings. Both inputs may carry CRLF line endings.
import { inputError } from "./render-errors.mjs";

const FENCE_OPEN = /^```([A-Za-z0-9_-]*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const SECTION_HEADING = /^## (\d+)\. /;
const ANY_H2 = /^## /;
const SPRINT_HEADING = /^### Sprint (\S+?):/;
const ANY_H2_OR_H3 = /^#{2,3} /;
const TEMPLATE_LABEL = "Template:";

/**
 * @typedef {object} Fence
 * @property {string} info the text after the opening backticks (empty for a plain fence)
 * @property {string} body the lines between the fences, joined with LF
 * @property {string} label the last non-blank line before the opening fence, trimmed
 */

/**
 * @typedef {object} RawPackageBlock
 * @property {string} headingId the id in the "### Sprint N: name" heading
 * @property {string} yaml the text of the yaml fence below it
 */

/**
 * Converts CRLF and lone CR to LF so every later step sees one line ending.
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The lines of "## <number>. ..." up to the next "## " heading, or null when absent.
 * @param {string} markdown
 * @param {number} number
 * @returns {string[] | null}
 */
export function sectionLines(markdown, number) {
  const lines = normalizeNewlines(markdown).split("\n");
  const start = lines.findIndex((l) => {
    const m = SECTION_HEADING.exec(l);
    return m !== null && Number(m[1]) === number;
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => ANY_H2.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Every fenced block in the lines, in order. An unterminated fence is an error.
 * @param {string[]} lines
 * @param {string} where used in the error message
 * @returns {Fence[]}
 */
export function fencesIn(lines, where) {
  /** @type {Fence[]} */
  const fences = [];
  let label = "";
  let open = null;
  /** @type {string[]} */
  let body = [];
  for (const line of lines) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line);
      if (m === null) {
        if (line.trim() !== "") label = line.trim();
        continue;
      }
      open = { info: m[1] ?? "", label };
      body = [];
    } else if (FENCE_CLOSE.test(line)) {
      fences.push({ info: open.info, label: open.label, body: body.join("\n") });
      open = null;
      label = "";
    } else {
      body.push(line);
    }
  }
  if (open !== null) throw inputError(`${where}: a code fence is opened but never closed`);
  return fences;
}

/**
 * The universal preamble: the first plain fence under section 1 of PROMPT-BOOK.md.
 * @param {string} promptBook
 * @returns {string}
 */
export function extractPreamble(promptBook) {
  const where = "PROMPT-BOOK.md section 1 (Universal preamble)";
  const lines = sectionLines(promptBook, 1);
  if (lines === null) throw inputError(`${where}: heading "## 1. ..." not found`);
  const fence = fencesIn(lines, where).find((f) => f.info === "");
  if (fence === undefined) throw inputError(`${where}: no fenced block found under the heading`);
  return fence.body;
}

/**
 * The level-1 template: the fence that follows the line "Template:" in section 3.
 * @param {string} promptBook
 * @returns {string}
 */
export function extractLevel1Template(promptBook) {
  const where = "PROMPT-BOOK.md section 3 (Mini-sprint orchestrator prompt)";
  const lines = sectionLines(promptBook, 3);
  if (lines === null) throw inputError(`${where}: heading "## 3. ..." not found`);
  const fence = fencesIn(lines, where).find((f) => f.label === TEMPLATE_LABEL);
  if (fence === undefined) {
    throw inputError(`${where}: no fenced block found after a line reading "${TEMPLATE_LABEL}"`);
  }
  return fence.body;
}

/**
 * Every "### Sprint N: name" heading in MINI-SPRINT-ORDER.md with the yaml fence under it.
 * @param {string} order
 * @returns {RawPackageBlock[]}
 */
export function extractPackageBlocks(order) {
  const lines = normalizeNewlines(order).split("\n");
  /** @type {RawPackageBlock[]} */
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = SPRINT_HEADING.exec(lines[i] ?? "");
    if (heading === null) continue;
    const headingId = heading[1] ?? "";
    const tail = lines.slice(i + 1);
    const stop = tail.findIndex((l) => ANY_H2_OR_H3.test(l));
    const scope = stop === -1 ? tail : tail.slice(0, stop);
    const fence = fencesIn(scope, `MINI-SPRINT-ORDER.md, "Sprint ${headingId}"`).find(
      (f) => f.info === "yaml",
    );
    if (fence === undefined) {
      throw inputError(`MINI-SPRINT-ORDER.md: "### Sprint ${headingId}" has no yaml fence`);
    }
    blocks.push({ headingId, yaml: fence.body });
  }
  return blocks;
}
