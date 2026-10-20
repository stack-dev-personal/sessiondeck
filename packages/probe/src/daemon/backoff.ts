export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Full-jitter exponential backoff: a delay drawn uniformly from [0, min(cap, base * 2^attempt)).
 * attempt counts from 0. `rng` returns [0, 1).
 */
export function backoffDelay(
  attempt: number,
  rng: () => number = Math.random,
  base = BACKOFF_BASE_MS,
  cap = BACKOFF_CAP_MS,
): number {
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 30));
  return Math.floor(rng() * ceiling);
}
