import type { SessionSnapshot } from "@sessiondeck/contract";
import type { SessionRow } from "./db/store.ts";
import { applyRateLimitStaleness } from "./ingest/reduce.ts";

/** R2.6: ended and exited sessions stay in the live view this long after they ended. */
export const LIVE_GRACE_MS = 10 * 60 * 1000;

/** Largest page any list endpoint (and the WS initial payload) returns. */
export const MAX_LIMIT = 1000;

/**
 * The one way a stored snapshot leaves the hub (REST and WS): parsed, then R2.7 staleness applied
 * against the current time, so an idle session never shows a window past its resets_at.
 */
export function readSnapshot(row: SessionRow, nowMs: number): SessionSnapshot {
  return applyRateLimitStaleness(JSON.parse(row.snapshot) as SessionSnapshot, nowMs);
}
