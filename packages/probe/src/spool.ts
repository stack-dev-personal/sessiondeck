/**
 * Spool line format, shared by the hook (writer) and the daemon (reader).
 *
 * One spool line is one contract Envelope WITHOUT `seq`: `JSON.stringify(line) + "\n"`, appended
 * with a single write to an O_APPEND descriptor of `<spool>/<yyyy-mm-dd>.jsonl` (UTC date); each
 * line is one write and under 64 KB, so concurrent hooks cannot interleave inside a line.
 *
 * The hook does not assign `seq`. The daemon (S2) is the single reader of the spool: it assigns
 * `seq` in file order and persists it together with its cursor, so seq has no gaps and no
 * duplicates by construction. The daemon must ignore anything in the spool directory that does
 * not end in `.jsonl`.
 *
 * This module is the reader-facing side and pulls the contract schema (zod) at runtime. The hook
 * bundle must not import it; the hook uses spool-format.ts (types, constants) and spool-writer.ts.
 */
import { EnvelopeSchema } from "@sessiondeck/contract";
import { MAX_LINE_BYTES, type SpoolLine } from "./spool-format.ts";

export { MAX_LINE_BYTES, type SpoolLine };

export type ParsedSpoolLine = { ok: true; line: SpoolLine } | { ok: false; error: string };

/**
 * Parses and validates one spool line (text without the trailing newline). Validation is the
 * contract EnvelopeSchema applied after adding a placeholder seq; any `seq` present in the text
 * is discarded.
 */
export function parseSpoolLine(text: string): ParsedSpoolLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "not-an-object" };
  }
  const res = EnvelopeSchema.safeParse({ ...(raw as Record<string, unknown>), seq: 0 });
  if (!res.success) return { ok: false, error: res.error.issues[0]?.message ?? "invalid-envelope" };
  const line: Partial<typeof res.data> = { ...res.data };
  delete line.seq;
  return { ok: true, line: line as SpoolLine };
}
