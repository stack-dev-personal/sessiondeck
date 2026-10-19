import {
  GuardKilledError,
  MAX_ATTEMPTS,
  rawMs,
  settleKilled,
  TimingBoundError,
  workMs,
  type TimedRun,
} from "./guard-timing";

/** The large run does GROWTH_SCALE times the work of the small run. */
export const GROWTH_SCALE = 4;
/** Linear work gives a ratio near GROWTH_SCALE, quadratic gives its square (16), exponential more. */
export const MAX_GROWTH_RATIO = 8;
/**
 * Match times under this are clamped to it, so noise on a small run cannot fail a ratio. With a
 * 1 ms floor a linear shape failed once the large run hit 8 ms (7.3 and 7.4 ms seen under load);
 * at 3 ms it needs 24 ms. A quadratic still gives 16x, and the large-run bounds below catch a
 * slow large run whatever the ratio says.
 */
export const GROWTH_FLOOR_MS = 3;
/**
 * The large run has GROWTH_SCALE times the input, so its absolute limits are this many times the
 * small run's, not GROWTH_SCALE: linear work that is just inside the small limit still passes, but
 * a large run that is slow in absolute terms (non-regex work, or a quadratic part under half the
 * linear part, which the ratio hides) fails. The real hook timeout is 5 s and a timeout allows;
 * wall time is not bounded (process start under load), see HANG_KILL_MS in guard-timing.ts.
 */
export const BIG_RUN_FACTOR = 2;

/** Match time of the large run over the small one, with the small one clamped to the floor. */
export function growthRatio(smallMatchMs: number, bigMatchMs: number): number {
  return bigMatchMs / Math.max(smallMatchMs, GROWTH_FLOOR_MS);
}

export interface GrowthPair {
  readonly small: TimedRun;
  readonly big: TimedRun;
}

/**
 * Absolute limits of the small run; the large run gets BIG_RUN_FACTOR times the match and work
 * limits. The rawMs limit (idle included, execSync excluded, see MAX_RAW_SCRIPT_MS) is not scaled:
 * the hook timeout is absolute, so both runs stay under it.
 */
export interface GrowthLimits {
  readonly matchMs: number;
  readonly workMs: number;
  readonly rawMs: number;
}

export interface GrowthResult extends GrowthPair {
  readonly ratio: number;
  /** How many pairs it took, 1 to maxAttempts. Logged as evidence. */
  readonly attempts: number;
  /** How many of those attempts were killed at the kill limit (a failed attempt, retried). Evidence. */
  readonly kills: number;
}

function ratioOf(pair: GrowthPair): number {
  return growthRatio(pair.small.matchMs, pair.big.matchMs);
}

/** A status mismatch is deterministic (it does not depend on runner load), so it is never retried. */
export function statusMatches(pair: GrowthPair, status: number): boolean {
  return pair.small.status === status && pair.big.status === status;
}

/** The large run alone: absolute match and work time at BIG_RUN_FACTOR times the limits, rawMs at the limit. Guard-side time only. */
export function bigRunWithin(big: TimedRun, limits: GrowthLimits): boolean {
  return (
    big.matchMs < BIG_RUN_FACTOR * limits.matchMs &&
    workMs(big) < BIG_RUN_FACTOR * limits.workMs &&
    rawMs(big) < limits.rawMs
  );
}

/** Which bounds a pair broke, as text for the log; empty when it is within all of them. */
export function growthViolations(pair: GrowthPair, limits: GrowthLimits): string[] {
  const broken: string[] = [];
  if (ratioOf(pair) >= MAX_GROWTH_RATIO) {
    broken.push(`ratio ${ratioOf(pair).toFixed(2)} >= ${MAX_GROWTH_RATIO}`);
  }
  if (pair.small.matchMs >= limits.matchMs) {
    broken.push(`small matchMs ${pair.small.matchMs.toFixed(1)} >= ${limits.matchMs}`);
  }
  if (workMs(pair.small) >= limits.workMs) {
    broken.push(`small workMs ${workMs(pair.small).toFixed(1)} >= ${limits.workMs}`);
  }
  if (rawMs(pair.small) >= limits.rawMs) {
    broken.push(`small rawMs ${rawMs(pair.small).toFixed(1)} >= ${limits.rawMs}`);
  }
  if (pair.big.matchMs >= BIG_RUN_FACTOR * limits.matchMs) {
    broken.push(`big matchMs ${pair.big.matchMs.toFixed(1)} >= ${BIG_RUN_FACTOR * limits.matchMs}`);
  }
  if (workMs(pair.big) >= BIG_RUN_FACTOR * limits.workMs) {
    broken.push(`big workMs ${workMs(pair.big).toFixed(1)} >= ${BIG_RUN_FACTOR * limits.workMs}`);
  }
  if (rawMs(pair.big) >= limits.rawMs) {
    broken.push(`big rawMs ${rawMs(pair.big).toFixed(1)} >= ${limits.rawMs}`);
  }
  return broken;
}

/**
 * Throws TimingBoundError when a pair broke a ratio or time bound, so the CI retry runner (scripts/ci)
 * may run the file again; nothing else in a growth row throws it. Call it AFTER the deterministic
 * asserts (status, execCalls, execCommands, calls).
 */
export function assertGrowthWithinBounds(pair: GrowthPair, limits: GrowthLimits): void {
  const broken = growthViolations(pair, limits);
  if (broken.length > 0) {
    throw new TimingBoundError(broken);
  }
}

export function growthWithin(pair: GrowthPair, limits: GrowthLimits): boolean {
  return growthViolations(pair, limits).length === 0;
}

/**
 * Calls `runPair` (a small run, then a large run) until a pair is within the ratio and the small
 * run's absolute limits and the large run's bounds, at most `maxAttempts` times. A status mismatch is returned at once. If
 * every attempt violates a bound, the pair with the highest ratio is returned, so noise has to hit
 * all attempts to fail a row while a real quadratic, which hits every attempt, still fails.
 */
export async function firstGrowthWithin(
  runPair: () => Promise<GrowthPair>,
  status: number,
  limits: GrowthLimits,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<GrowthResult> {
  if (maxAttempts < 1) {
    throw new Error("firstGrowthWithin needs maxAttempts of at least 1");
  }
  let worst: GrowthPair | undefined;
  let killed: GuardKilledError | undefined;
  let kills = 0;
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    // A wall-timeout kill is a bound violation like a slow run: retried, rethrown if every attempt dies.
    const pair = await settleKilled(runPair);
    if (pair instanceof GuardKilledError) {
      killed = pair;
      kills += 1;
      console.info(`guard growth attempt ${attempts} rejected: ${pair.message}`);
      continue;
    }
    const broken = growthViolations(pair, limits);
    if (!statusMatches(pair, status) || broken.length === 0) {
      return { ...pair, ratio: ratioOf(pair), attempts, kills };
    }
    console.info(`guard growth attempt ${attempts} rejected: ${broken.join(", ")}`);
    worst = worst === undefined || ratioOf(pair) > ratioOf(worst) ? pair : worst;
  }
  // maxAttempts >= 1 and the loop ran, so a pair or a kill exists; the guard keeps the type honest.
  if (worst === undefined) {
    throw killed ?? new Error("firstGrowthWithin ran no attempt");
  }
  return { ...worst, ratio: ratioOf(worst), attempts: maxAttempts, kills };
}
