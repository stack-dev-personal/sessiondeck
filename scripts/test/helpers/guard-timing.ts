import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const preloadUrl = pathToFileURL(resolve(here, "regexp-timing-preload.mjs")).href;

/** Spawn timeout: the real hook timeout is 5 s and a timeout lets the command run. */
export const MAX_WALL_MS = 4000;

/**
 * The helper's own wall timeout fired. It is a wall-time bound violation, so a retrying row
 * (`firstWithinBounds`) counts it as an attempt; a guard that really hangs is killed on every
 * attempt and the row fails with this error.
 */
export class GuardKilledError extends Error {
  constructor(timeoutMs: number, signal: NodeJS.Signals) {
    super(`guard killed after ${timeoutMs} ms wall (signal ${signal})`);
    this.name = "GuardKilledError";
  }
}

export interface TimedOptions {
  /** Spawn timeout. Defaults to MAX_WALL_MS. */
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
      timeout: options.timeoutMs ?? MAX_WALL_MS,
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
 * Runs a node script with the regex timing preload. The stdin JSON has the shape the guard hook
 * receives. A missing or unparsable timing file throws, so it can never read as 0 ms. Async so
 * tests can run concurrently inside one worker instead of blocking it on each spawn.
 */
export async function runTimed(
  scriptPath: string,
  command: string,
  cwd: string,
  options: TimedOptions = {},
): Promise<TimedRun> {
  const timeoutMs = options.timeoutMs ?? MAX_WALL_MS;
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
}

export function matchesDeterministic(run: TimedRun, expected: DeterministicExpectation): boolean {
  return (
    run.status === expected.status &&
    run.calls === expected.calls &&
    run.execCalls === expected.execCalls
  );
}

export function withinBounds(run: TimedRun, bounds: TimingBounds): boolean {
  return run.matchMs < bounds.matchMs && workMs(run) < bounds.workMs && run.wallMs < MAX_WALL_MS;
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
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const run = await settleKilled(runOnce);
    if (run instanceof GuardKilledError) {
      killed = run;
      continue;
    }
    if (!matchesDeterministic(run, expected) || withinBounds(run, bounds)) {
      return { run, attempts };
    }
    best = best === undefined || workMs(run) < workMs(best) ? run : best;
  }
  if (best === undefined) {
    throw killed ?? new Error("firstWithinBounds needs maxAttempts of at least 1");
  }
  return { run: best, attempts: maxAttempts };
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
