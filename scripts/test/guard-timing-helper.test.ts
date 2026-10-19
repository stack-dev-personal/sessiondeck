import { describe, expect, it } from "vitest";
import {
  firstWithinBounds,
  GuardKilledError,
  matchesDeterministic,
  MAX_ATTEMPTS,
  MAX_WALL_MS,
  TIMING_SLOTS,
  withinBounds,
  withSlot,
  type TimedRun,
} from "./helpers/guard-timing";

const BOUNDS = { matchMs: 150, workMs: 300 };
const EXPECTED = { status: 0, calls: 8, execCalls: 0 };

function run(overrides: Partial<TimedRun> = {}): TimedRun {
  return {
    status: 0,
    matchMs: 1,
    calls: 8,
    scriptMs: 20,
    stdinWaitMs: 5,
    stdinIdleMs: 5,
    execMs: 0,
    execCalls: 0,
    wallMs: 100,
    ...overrides,
  };
}

/** A runOnce that serves the given runs in order and counts its calls. */
function sequence(runs: readonly (TimedRun | Error)[]): {
  runOnce: () => Promise<TimedRun>;
  count: () => number;
} {
  let calls = 0;
  return {
    runOnce: () => {
      const next = runs[Math.min(calls, runs.length - 1)];
      calls += 1;
      if (next === undefined) {
        return Promise.reject(new Error("sequence needs at least one run"));
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    count: () => calls,
  };
}

describe("guard timing helper: first run within bounds", () => {
  it("matchesDeterministic compares status, calls and execCalls", () => {
    expect(matchesDeterministic(run(), EXPECTED)).toBe(true);
    expect(matchesDeterministic(run({ status: 2 }), EXPECTED)).toBe(false);
    expect(matchesDeterministic(run({ calls: 9 }), EXPECTED)).toBe(false);
    expect(matchesDeterministic(run({ execCalls: 1 }), EXPECTED)).toBe(false);
  });

  it("withinBounds checks match time, script time minus waits, and wall time", () => {
    expect(withinBounds(run(), BOUNDS)).toBe(true);
    expect(withinBounds(run({ matchMs: 150 }), BOUNDS)).toBe(false);
    expect(withinBounds(run({ scriptMs: 400, stdinIdleMs: 0 }), BOUNDS)).toBe(false);
    // Idle stdin wait and execSync are subtracted before the script bound applies.
    expect(withinBounds(run({ scriptMs: 400, stdinIdleMs: 150, execMs: 100 }), BOUNDS)).toBe(true);
    expect(withinBounds(run({ wallMs: MAX_WALL_MS }), BOUNDS)).toBe(false);
  });

  it("stops after one attempt when the first run is within bounds", async () => {
    const seq = sequence([run()]);
    const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(result.attempts).toBe(1);
    expect(result.kills).toBe(0);
    expect(seq.count()).toBe(1);
  });

  it("retries a run that violates a bound and passes on a later attempt", async () => {
    const seq = sequence([run({ matchMs: 400 }), run({ matchMs: 2 })]);
    const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(result.attempts).toBe(2);
    expect(result.run.matchMs).toBe(2);
  });

  it("fails a row only when all attempts violate a bound, returning the best run", async () => {
    const seq = sequence([
      run({ scriptMs: 900, stdinIdleMs: 0 }),
      run({ scriptMs: 500, stdinIdleMs: 0 }),
      run({ scriptMs: 700, stdinIdleMs: 0 }),
    ]);
    const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(seq.count()).toBe(MAX_ATTEMPTS);
    expect(result.run.scriptMs).toBe(500);
    expect(withinBounds(result.run, BOUNDS)).toBe(false);
  });

  it("does not retry a status or call-count mismatch", async () => {
    for (const bad of [run({ status: 2 }), run({ calls: 9 }), run({ execCalls: 1 })]) {
      const seq = sequence([bad, run()]);
      const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
      expect(result.attempts).toBe(1);
      expect(seq.count()).toBe(1);
      expect(matchesDeterministic(result.run, EXPECTED)).toBe(false);
    }
  });

  const killed = (): GuardKilledError => new GuardKilledError(4000, "SIGTERM");

  it("counts a wall-timeout kill as a bound violation and retries", async () => {
    const seq = sequence([killed(), run()]);
    const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(result.attempts).toBe(2);
    expect(result.kills).toBe(1);
    expect(seq.count()).toBe(2);
  });

  it("counts every kill among the attempts, also when a slow run follows them", async () => {
    const slow = run({ matchMs: 400 });
    const seq = sequence([killed(), slow, killed()]);
    const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(result.kills).toBe(2);
    expect(result.run).toBe(slow);
  });

  it("rethrows the kill when every attempt is killed", async () => {
    const seq = sequence([killed()]);
    await expect(firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS)).rejects.toThrow(
      /guard killed after 4000 ms wall/,
    );
    expect(seq.count()).toBe(MAX_ATTEMPTS);
  });

  it("does not retry other errors, such as a missing timing file", async () => {
    const seq = sequence([new Error("timing file missing or unparsable"), run()]);
    await expect(firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS)).rejects.toThrow(/timing file/);
    expect(seq.count()).toBe(1);
  });

  it("rejects a maxAttempts below 1 instead of passing silently", async () => {
    await expect(firstWithinBounds(sequence([run()]).runOnce, EXPECTED, BOUNDS, 0)).rejects.toThrow(
      /at least 1/,
    );
  });
});

describe("guard timing helper: spawn slots", () => {
  it("never runs more than TIMING_SLOTS tasks at once and runs them all", async () => {
    let active = 0;
    let peak = 0;
    const task = async (id: number): Promise<number> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 20));
      active -= 1;
      return id;
    };
    const ids = Array.from({ length: TIMING_SLOTS * 4 }, (_, id) => id);
    const done = await Promise.all(ids.map((id) => withSlot(() => task(id))));
    expect(done).toEqual(ids);
    expect(peak).toBe(TIMING_SLOTS);
  });

  it("frees the slot when a task throws", async () => {
    await expect(withSlot(() => Promise.reject(new Error("boom")))).rejects.toThrow(/boom/);
    await expect(withSlot(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
