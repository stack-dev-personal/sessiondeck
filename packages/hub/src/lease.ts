// The serving hub keeps one row in hub_lease fresh. `hub replay` and `hub compact` read it and
// refuse while it is live (the hub's in-memory state would go stale after a replay, and two
// compactors are only safe through the per-batch write transaction). The lease lives in the
// database, so nothing is lost on restart: a crashed hub's lease simply expires.
import { randomUUID } from "node:crypto";
import type { Store } from "./db/store.ts";
import type { Logger } from "./ingest/ingestor.ts";

export const LEASE_REFRESH_MS = 5_000;
export const LEASE_TTL_MS = 15_000;

/** Milliseconds until a fresh lease expires, or null when none is held. */
export function leaseRemainingMs(store: Store, now: number = Date.now()): number | null {
  const l = store.getLease();
  return l !== undefined && l.expires_at > now ? l.expires_at - now : null;
}

export function startLease(
  store: Store,
  log: Logger,
  opts: { refreshMs?: number; ttlMs?: number; now?: () => number } = {},
): { stop: () => void } {
  const holder = randomUUID();
  const ttl = opts.ttlMs ?? LEASE_TTL_MS;
  const now = opts.now ?? Date.now;
  const beat = (): void => {
    try {
      store.setLease(holder, now() + ttl);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "lease refresh failed");
    }
  };
  beat();
  const timer = setInterval(beat, opts.refreshMs ?? LEASE_REFRESH_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      try {
        store.clearLease(holder);
      } catch {
        // the lease expires on its own
      }
    },
  };
}
