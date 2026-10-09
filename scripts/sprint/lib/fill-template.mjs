// Turns a parsed package into placeholder values and fills the level-1 template.
// Pure functions; nothing here reads the file system or the environment.
import { inputError } from "./render-errors.mjs";

/** Generic references the sprint orchestrator fills per session later. They stay literal. */
export const PASS_THROUGH = Object.freeze(["SESSION_ID", "SESSION_BRANCH"]);

/** The placeholder that carries the universal preamble, which itself holds placeholders. */
export const PREAMBLE_TOKEN = "UNIVERSAL PREAMBLE";

/** {UPPER_SNAKE} or {UPPER WORDS}: two or more characters, upper case letters, underscore, space. */
const PLACEHOLDER = /\{([A-Z][A-Z_ ]*[A-Z])\}/g;

/** The template line that opens the package list. Extras are appended after its bullets. */
const PACKAGE_ANCHOR = "Package (from MINI-SPRINT-ORDER.md";

/** Shown when a list is empty, so the prompt never has a blank where a value should be. */
const NONE = "none";

/**
 * @typedef {import("./package-block.mjs").SprintPackage} SprintPackage
 * @typedef {import("./package-block.mjs").SessionSpec} SessionSpec
 */

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T, index: number) => string} line
 * @returns {string} a value that starts on a new line, one line per item
 */
function lines(items, line) {
  return items.map((item, i) => `\n  ${line(item, i)}`).join("");
}

/**
 * One line per session with every field spelled key: value, separated by " | ".
 * @param {SessionSpec} s
 * @returns {string}
 */
export function sessionLine(s) {
  const parts = [
    `${s.id}`,
    `handoff: docs/handoffs/${s.handoff}`,
    `branch: ${s.branch}`,
    `phase: ${s.phase}`,
    `depends_on: ${s.depends_on.length === 0 ? NONE : s.depends_on.join(", ")}`,
    `security_gated: ${s.security_gated ? "yes" : "no"}`,
  ];
  if (s.lane !== undefined) parts.push(`lane: ${s.lane}`);
  if (s.goal !== undefined) parts.push(`goal: ${JSON.stringify(s.goal)}`);
  if (s.optional !== undefined) parts.push(`optional: ${s.optional ? "yes" : "no"}`);
  if (s.user_gate !== undefined) parts.push(`user_gate: ${JSON.stringify(s.user_gate)}`);
  return `- ${parts.join(" | ")}`;
}

/**
 * Values for every placeholder except the preamble.
 * @param {SprintPackage} pkg
 * @param {string} contractSha
 * @returns {Record<string, string>}
 */
export function placeholderValues(pkg, contractSha) {
  return {
    SPRINT_ID: pkg.sprint,
    SPRINT_NAME: pkg.name,
    SPRINT_SLUG: pkg.slug,
    CONTRACT_SHA: contractSha,
    MAX_PARALLEL: String(pkg.max_parallel),
    SESSION_TABLE: lines(pkg.sessions, (s) => sessionLine(s)),
    MERGE_ORDER: pkg.merge_order.join(" -> "),
    INTEGRATION_CHECKS: lines(pkg.integration_checks, (c, i) => `${i + 1}. ${c}`),
    USER_GATES: pkg.user_gates.length === 0 ? NONE : lines(pkg.user_gates, (g) => `- ${g}`),
  };
}

/**
 * Embeds the preamble, then replaces every placeholder in one pass. Values are never rescanned, so
 * a value that contains braces cannot be mistaken for a hole. Pass-through names stay literal.
 * Any other token without a value is an error naming every such token.
 * @param {string} template
 * @param {string} preamble
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fillTemplate(template, preamble, values) {
  const marker = `{${PREAMBLE_TOKEN}}`;
  const count = template.split(marker).length - 1;
  if (count !== 1) {
    throw inputError(
      `PROMPT-BOOK.md section 3: the template must contain ${marker} exactly once (found ${count})`,
    );
  }
  const combined = template.replace(marker, () => preamble);
  /** @type {string[]} */
  const unfilled = [];
  const filled = combined.replace(PLACEHOLDER, (token, name) => {
    if (PASS_THROUGH.includes(name)) return token;
    if (Object.hasOwn(values, name)) return values[name] ?? "";
    if (!unfilled.includes(token)) unfilled.push(token);
    return token;
  });
  if (unfilled.length > 0) {
    throw inputError(
      `PROMPT-BOOK.md sections 1 and 3: placeholder ${unfilled.join(", ")} has no value; ` +
        `the renderer fills ${Object.keys(values).join(", ")} and leaves ${PASS_THROUGH.join(", ")} literal`,
    );
  }
  return filled;
}

/**
 * Appends needs_laptop and notes after the bullet list that follows the "Package (" line, without
 * touching the template's own wording. Returns the text unchanged when the block has neither.
 * @param {string} rendered
 * @param {SprintPackage} pkg
 * @returns {string}
 */
export function appendPackageExtras(rendered, pkg) {
  /** @type {string[]} */
  const extra = [];
  if (pkg.needs_laptop !== undefined && pkg.needs_laptop.length > 0) {
    extra.push(
      "- Needs laptop confirmation (cannot be verified in this container):",
      ...pkg.needs_laptop.map((n) => `  - ${n}`),
    );
  }
  if (pkg.notes !== undefined) extra.push(`- Notes: ${pkg.notes}`);
  if (extra.length === 0) return rendered;
  const all = rendered.split("\n");
  const start = all.findIndex((l) => l.startsWith(PACKAGE_ANCHOR));
  if (start === -1) {
    throw inputError(
      `PROMPT-BOOK.md section 3: no line starting "${PACKAGE_ANCHOR}"; cannot place needs_laptop and notes`,
    );
  }
  let end = start + 1;
  while (end < all.length && (all[end]?.startsWith("- ") || all[end]?.startsWith("  "))) end += 1;
  return [...all.slice(0, end), ...extra, ...all.slice(end)].join("\n");
}
