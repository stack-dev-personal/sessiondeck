// Dependency-free pieces of the spool format, safe to bundle into the hook (no zod). The
// reader-facing API is re-exported from spool.ts.
import type { Envelope } from "@sessiondeck/contract";

/** One spool line: a contract Envelope without seq (the daemon assigns seq; see spool.ts). */
export type SpoolLine = Omit<Envelope, "seq">;

export const MAX_LINE_BYTES = 64 * 1024;
