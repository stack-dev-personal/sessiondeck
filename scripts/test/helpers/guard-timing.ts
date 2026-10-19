import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const preloadUrl = pathToFileURL(resolve(here, "regexp-timing-preload.mjs")).href;

/**
 * Kill limit of a timed spawn. It exists only to catch a hang; it is not a performance bound. The
 * real hook timeout is 5 s and a timeout lets the command run, so the property under test is that
 * the guard's OWN work stays far below 5 s. That is bounded by workMs and matchMs (the callers pass
 * 300 ms and 150 ms, 6 and 3 percent of the hook timeout; the large run of a growth row gets twice
 * that), which exclude node start-up, the stdin wait and execSync. Wall time is not a bound: it
 * measures Windows process start under contention. On a 4-core runner a row finished at a wall
 * time of 3950 ms with 76 ms of guard work, and two rows were killed at 4000 ms with at most 231 ms
 * of guard work. So the kill is twice the hook timeout: start-up noise cannot reach it, and a guard
 * that runs past it (a hang, or work that exceeds even 10 s) fails the row on every attempt. A
 * guard whose work takes seconds but finishes before the kill fails on workMs.
 */
export const HANG_KILL_MS = 10_000;

/**
 * Upper bound for the vitest timeout of a row that makes `spawns` timed spawns per attempt, for
 * `maxAttempts` attempts. Each spawn may wait for a timing slot (SLOT_WAIT_MS) and may run until
 * the kill limit. A passing row takes about a second; this is only reached when a guard hangs. The
 * slot wait counts against the test timeout, so a row with several spawns (a growth row has two)
 * needs more than the 30 s default.
 */
export const SLOT_WAIT_MS = 10_000;
export function rowTimeoutMs(spawns: number, maxAttempts: number = MAX_ATTEMPTS): number {
  return maxAttempts * spawns * (HANG_KILL_MS + SLOT_WAIT_MS);
}

/**
 * The helper's own kill limit (HANG_KILL_MS) fired. A retrying row (`firstWithinBounds`) counts it
 * as a failed attempt; a guard that really hangs is killed on every attempt and the row fails with
 * this error.
 */
export class GuardKilledError extends Error {
  constructor(timeoutMs: number, signal: NodeJS.Signals) {
    super(`guard killed after ${timeoutMs} ms wall (signal ${signal})`);
    this.name = "GuardKilledError";
  }
}

export interface TimedOptions {
  /** Kill limit. Defaults to HANG_KILL_MS. */
  readonly timeoutMs?: number;
  /** Delay before the stdin JSON is written, to prove the stdin wait is subtracted. */
  readonly stdinDelayMs?: number;
}

/** Script time the guard itself spent: idle stdin wait (set by the test process) and execSync excluded. */
export function workMs(run: Pick<TimedRun, "scriptMs" | "stdinIdleMs" | "execMs">): number {
  return run.scriptMs - run.stdinIdleMs - run.execMs;
}

export interface TimedRun {
  readonly status: number | null;
  readonly matchMs: number;
  readonly calls: number;
  /** Preload end to process exit, including stdinWaitMs and execMs. */
  readonly scriptMs: number;
  /** Preload end to stdin end, raw. Evidence only; workMs subtracts stdinIdleMs. */
  readonly stdinWaitMs: number;
  /** Event loop idle time inside the stdin window. Set by the test process, not by the guard. */
  readonly stdinIdleMs: number;
  /** Time inside child_process.execSync. */
  readonly execMs: number;
  readonly execCalls: number;
  readonly wallMs: number;
}

type Totals = Pick<
  TimedRun,
  "matchMs" | "calls" | "scriptMs" | "stdinWaitMs" | "stdinIdleMs" | "execMs" | "execCalls"
>;
const TOTAL_KEYS = [
  "matchMs",
  "calls",
  "scriptMs",
  "stdinWaitMs",
  "stdinIdleMs",
  "execMs",
  "execCalls",
] as const;

function readTotals(file: string): Totals {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`timing file missing or unparsable: ${String(error)}`);
  }
  const totals = parsed as Record<string, unknown>;
  if (totals.stdinWaitMs === null) {
    throw new Error("stdin end was not recorded by the preload (timing file has no stdin wait)");
  }
  if (!TOTAL_KEYS.every((key) => typeof totals[key] === "number")) {
    throw new Error(`timing file has the wrong shape: ${JSON.stringify(parsed)}`);
  }
  return parsed as Totals;
}

interface Exit {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** True when the helper's own timeout fired (child.killed), not when the child killed itself. */
  readonly killedByHelper?: boolean;
  readonly error?: Error;
}

function spawnWithInput(
  args: string[],
  input: string,
  timingFile: string,
  options: TimedOptions,
): Promise<Exit> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, args, {
      timeout: options.timeoutMs ?? HANG_KILL_MS,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, SD_GUARD_TIMING_FILE: timingFile },
    });
    child.on("error", (error) => resolveExit({ status: null, error }));
    child.on("close", (status, signal) =>
      resolveExit({ status, signal, killedByHelper: child.killed }),
    );
    child.stdin.on("error", () => undefined); // child may exit before reading all input
    if (options.stdinDelayMs) {
      setTimeout(() => child.stdin.end(input), options.stdinDelayMs);
    } else {
      child.stdin.end(input);
    }
  });
}

/**
 * Timed spawns allowed at once per test file (the module, and so the counter, is loaded once per
 * file: vitest isolates modules per file). The timing rows run concurrently so the file stays
 * short, but every extra concurrent guard process competes for the same cores as the other workers
 * of `pnpm -r test`, and a passing first attempt then lands near its bound (227 ms against 300 ms
 * was seen). Two slots measured: worst first-attempt script time 140 to 160 ms in `pnpm -r test`
 * (unlimited: 226 to 266 ms), for 1 to 2 s more suite time. The slot wait is outside the measured
 * times but inside the vitest test timeout (see rowTimeoutMs).
 */
export const TIMING_SLOTS = 2;

let activeSlots = 0;
const slotQueue: Array<() => void> = [];

export async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeSlots >= TIMING_SLOTS) {
    await new Promise<void>((resolveSlot) => slotQueue.push(resolveSlot));
  } else {
    activeSlots += 1;
  }
  try {
    return await task();
  } finally {
    const next = slotQueue.shift();
    if (next) {
      next(); // the slot passes to the next waiter, so activeSlots stays the same
    } else {
      activeSlots -= 1;
    }
  }
}

/**
 * Runs a node script with the regex timing preload. The stdin JSON has the shape the guard hook
 * receives. A missing or unparsable timing file throws, so it can never read as 0 ms. Async so
 * tests can run concurrently inside one worker instead of blocking it on each spawn.
 */
export function runTimed(
  scriptPath: string,
  command: string,
  cwd: string,
  options: TimedOptions = {},
): Promise<TimedRun> {
  return withSlot(() => runTimedNow(scriptPath, command, cwd, options));
}

async function runTimedNow(
  scriptPath: string,
  command: string,
  cwd: string,
  options: TimedOptions,
): Promise<TimedRun> {
  const timeoutMs = options.timeoutMs ?? HANG_KILL_MS;
  const dir = mkdtempSync(join(tmpdir(), "sd-guard-timing-"));
  const timingFile = join(dir, "timing.json");
  try {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });
    const start = performance.now();
    const exit = await spawnWithInput(
      ["--import", preloadUrl, scriptPath],
      input,
      timingFile,
      options,
    );
    const wallMs = performance.now() - start;
    if (exit.error) {
      throw new Error(`spawn failed: ${exit.error.message}`);
    }
    // Only the helper's own timeout is a timeout. A child that kills itself (SIGKILL on Linux,
    // an exit code on Windows) falls through to readTotals and fails on the missing timing file.
    if (exit.signal && (exit.killedByHelper || wallMs >= timeoutMs)) {
      throw new GuardKilledError(timeoutMs, exit.signal);
    }
    return { status: exit.status, ...readTotals(timingFile), wallMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Attempts allowed before a timing row fails: it fails only if every attempt violates a bound. */
export const MAX_ATTEMPTS = 3;

/** Deterministic outputs of a row: they do not depend on runner load, so one mismatch is final. */
export interface DeterministicExpectation {
  readonly status: number;
  readonly calls: number;
  readonly execCalls: number;
}

/** Upper bounds (exclusive) on the load dependent numbers of a run. */
export interface TimingBounds {
  readonly matchMs: number;
  readonly workMs: number;
}

export interface AttemptedRun {
  readonly run: TimedRun;
  /** How many runs it took, 1 to maxAttempts. Logged as evidence. */
  readonly attempts: number;
  /** How many of those attempts were killed at the kill limit (a failed attempt, retried). Evidence. */
  readonly kills: number;
}

export function matchesDeterministic(run: TimedRun, expected: DeterministicExpectation): boolean {
  return (
    run.status === expected.status &&
    run.calls === expected.calls &&
    run.execCalls === expected.execCalls
  );
}

/** Which bounds a run broke, as text for the log; empty when it is within both. Guard-side time only. */
export function violations(run: TimedRun, bounds: TimingBounds): string[] {
  const broken: string[] = [];
  if (run.matchMs >= bounds.matchMs) {
    broken.push(`matchMs ${run.matchMs.toFixed(1)} >= ${bounds.matchMs}`);
  }
  if (workMs(run) >= bounds.workMs) {
    broken.push(`workMs ${workMs(run).toFixed(1)} >= ${bounds.workMs}`);
  }
  return broken;
}

export function withinBounds(run: TimedRun, bounds: TimingBounds): boolean {
  return violations(run, bounds).length === 0;
}

/**
 * Runs one attempt and returns a wall-timeout kill as a value, so a retry loop can count it as a
 * bound violation. Any other error (spawn failure, missing timing file) is not noise and propagates.
 */
export async function settleKilled<T>(attempt: () => Promise<T>): Promise<T | GuardKilledError> {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof GuardKilledError) {
      return error;
    }
    throw error;
  }
}

/**
 * Calls `runOnce` until a run is within all bounds, at most `maxAttempts` times. A status or call
 * count mismatch is deterministic, so that run is returned at once for the caller to assert on.
 * If every attempt violates a bound, the attempt with the lowest script time is returned (its
 * assertion fails), so noise has to hit all attempts to fail a row while a real regression, which
 * hits every attempt, still fails.
 */
export async function firstWithinBounds(
  runOnce: () => Promise<TimedRun>,
  expected: DeterministicExpectation,
  bounds: TimingBounds,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<AttemptedRun> {
  let best: TimedRun | undefined;
  let killed: GuardKilledError | undefined;
  let kills = 0;
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const run = await settleKilled(runOnce);
    if (run instanceof GuardKilledError) {
      killed = run;
      kills += 1;
      console.info(`guard timing attempt ${attempts} rejected: ${run.message}`);
      continue;
    }
    const broken = violations(run, bounds);
    if (!matchesDeterministic(run, expected) || broken.length === 0) {
      return { run, attempts, kills };
    }
    console.info(`guard timing attempt ${attempts} rejected: ${broken.join(", ")}`);
    best = best === undefined || workMs(run) < workMs(best) ? run : best;
  }
  if (best === undefined) {
    throw killed ?? new Error("firstWithinBounds needs maxAttempts of at least 1");
  }
  return { run: best, attempts: maxAttempts, kills };
}

/** Runs the guard under the timing preload until a run is within bounds (see firstWithinBounds). */
export function runTimedUntilWithin(
  scriptPath: string,
  command: string,
  cwd: string,
  expected: DeterministicExpectation,
  bounds: TimingBounds,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<AttemptedRun> {
  return firstWithinBounds(() => runTimed(scriptPath, command, cwd), expected, bounds, maxAttempts);
}
