// Per-fixture README for the scrubbed transcripts (R0.7). Counts, key names and reasons only;
// it never contains a value from the source.
import { DROP_KEYS } from "./transcript-scrub-rules.mjs";

/** @param {Map<string, number>} m @returns {string[]} */
const lines = (m) =>
  [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `- ${k}: ${n}`);

/**
 * @typedef {{
 *   rows: number, files: number, srcBytes: number, outBytes: number,
 *   types: Map<string, number>, subtypes: Map<string, number>, attachments: Map<string, number>,
 *   blocks: Map<string, number>, versions: Set<string>,
 *   dropped: Map<string, number>, denied: Map<string, number>,
 * }} FixtureStats
 */

/** @param {FixtureStats} s @param {string} dir @param {boolean} hasSubagents */
export function renderReadme(s, dir, hasSubagents) {
  const dropped = [...s.dropped].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return [
    `# transcripts/${dir}`,
    "",
    "Scrubbed Claude Code session transcript (R0.7, transcript extension). Written by",
    "`node scripts/fixture-scrub.mjs --transcripts`; do not edit by hand. Source content is not",
    "reproduced here: counts, key names and reasons only.",
    "",
    "## Covers",
    "",
    "- " +
      s.rows +
      " rows in " +
      s.files +
      " file(s): `session.jsonl`" +
      (hasSubagents ? " and `subagents/agent-<id>.jsonl` with their `.meta.json`" : "") +
      ".",
    `- Source size ${s.srcBytes} bytes, scrubbed size ${s.outBytes} bytes.`,
    `- Claude Code versions seen: ${[...s.versions].sort().join(", ") || "none"}.`,
    "- Row order and row count equal the source. Ids and parent links are kept verbatim.",
    "",
    "## Rows by type",
    "",
    ...lines(s.types),
    "",
    "## System rows by subtype",
    "",
    ...(s.subtypes.size > 0 ? lines(s.subtypes) : ["- none"]),
    "",
    "## Attachment rows by attachment type",
    "",
    ...(s.attachments.size > 0 ? lines(s.attachments) : ["- none"]),
    "",
    "## Content blocks by role and type",
    "",
    ...(s.blocks.size > 0 ? lines(s.blocks) : ["- none"]),
    "",
    "## Keys dropped to a `<BLOB n>` placeholder",
    "",
    "n is the JSON length of the dropped subtree. Scalars next to a dropped key are kept.",
    "",
    ...(dropped.length > 0
      ? dropped.map(
          ([k, n]) =>
            `- \`${k}\` (${n}): ${Object.hasOwn(DROP_KEYS, k) ? DROP_KEYS[/** @type {keyof typeof DROP_KEYS} */ (k)] : "base64 payload of an image or document source"}`,
        )
      : ["- none"]),
    "",
    "## Rules applied",
    "",
    "- Free text (prompts, replies, tool inputs and results, summaries, titles) is scrubbed, then cut",
    "  to 120 characters plus `<TRUNCATED n>` (n = original length) when longer.",
    "- `thinking` and `signature` become `<REDACTED-THINKING>`.",
    "- Paths become `<HOME>/...` or `<ROOT>/...` with numbered folder and file placeholders.",
    "- Emails, account and organization ids, request ids and token-shaped strings become",
    "  `<EMAIL>`, `<ACCOUNT>`, `<REQUEST_ID>`, `<REDACTED>`.",
    "- Strings at key paths not classified become `<TEXT n>` (n = original length): " +
      `${[...s.denied.values()].reduce((a, b) => a + b, 0)} in this fixture.`,
    "",
  ].join("\n");
}
