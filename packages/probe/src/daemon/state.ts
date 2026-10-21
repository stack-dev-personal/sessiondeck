import { readFile, rename } from "node:fs/promises";
import type { Envelope } from "@sessiondeck/contract";
import { writeFileAtomic } from "../install/atomic.ts";
import type { Cursor, Logger } from "./types.ts";

/**
 * A batch whose seq are assigned and which has not been acknowledged yet (the journal). It is
 * written, atomically, before the first send and resent verbatim after a restart.
 */
export interface PendingBatch {
  first_seq: number;
  /** Envelopes with seq, merged from the outbox and the hook spool in `ts` order. */
  envelopes: Envelope[];
  /** Indices (into envelopes) of the hook-spool envelopes. */
  spool_idx?: number[];
  /** Older journals: outbox envelopes first, hook-spool envelopes from this index. */
  spool_from?: number;
  /** Cursors the batch advances to. */
  spool?: Cursor;
  outbox?: Cursor;
}

/** One file: committed cursors, next_seq, and the pending-batch journal. Replaced atomically. */
export interface DaemonState {
  v: 1;
  next_seq: number;
  spool?: Cursor;
  outbox?: Cursor;
  pending?: PendingBatch;
}

export function freshState(): DaemonState {
  return { v: 1, next_seq: 0 };
}

function isCursor(c: unknown): c is Cursor {
  return (
    typeof c === "object" &&
    c !== null &&
    typeof (c as Cursor).file === "string" &&
    Number.isInteger((c as Cursor).offset) &&
    (c as Cursor).offset >= 0
  );
}

function valid(s: unknown): s is DaemonState {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  if (o["v"] !== 1 || !Number.isInteger(o["next_seq"]) || (o["next_seq"] as number) < 0)
    return false;
  for (const k of ["spool", "outbox"]) if (o[k] !== undefined && !isCursor(o[k])) return false;
  const p = o["pending"] as Record<string, unknown> | undefined;
  if (p !== undefined) {
    if (typeof p !== "object" || p === null) return false;
    if (!Number.isInteger(p["first_seq"]) || !Array.isArray(p["envelopes"])) return false;
    if (p["spool_from"] !== undefined && !Number.isInteger(p["spool_from"])) return false;
    const idx = p["spool_idx"];
    if (idx !== undefined && !(Array.isArray(idx) && idx.every((i) => Number.isInteger(i))))
      return false;
    for (const k of ["spool", "outbox"]) if (p[k] !== undefined && !isCursor(p[k])) return false;
  }
  return true;
}

export async function loadState(path: string, log: Logger): Promise<DaemonState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return freshState();
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (valid(parsed)) return parsed;
  } catch {
    // fall through
  }
  const aside = `${path}.corrupt-${Date.now()}`;
  log("error", `state file unreadable; moved to ${aside} and starting from the beginning`);
  await rename(path, aside).catch(() => undefined);
  return freshState();
}

export async function saveState(path: string, state: DaemonState): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(state), { mode: 0o600 });
}
