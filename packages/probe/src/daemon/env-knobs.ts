/** Smallest retry cap the env knob may set: 0 would make a failing hub a tight loop. */
export const MIN_BACKOFF_CAP_MS = 50;

/** SESSIONDECK_BACKOFF_CAP_MS: undefined when unset or not a number, else at least 50 ms. */
export function parseBackoffCapMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.max(MIN_BACKOFF_CAP_MS, n) : undefined;
}

/** SESSIONDECK_HEARTBEAT_MS: undefined when unset or not a non-negative number. */
export function parseHeartbeatMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
