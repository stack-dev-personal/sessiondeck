import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIMING_BOUND_PREFIX } from "../lib/guard-timing-retry.mjs";
import {
  assertWithinBounds,
  firstWithinBounds,
  GUARD_EXEC_COMMAND,
  GuardKilledError,
  HANG_KILL_MS,
  matchesDeterministic,
  MAX_RAW_SCRIPT_MS,
  rawMs,
  MAX_ATTEMPTS,
  rowTimeoutMs,
  SLOT_WAIT_MS,
  TIMING_SLOTS,
  TimingBoundError,
  violations,
  withinBounds,
  withSlot,
  workMs,
  type TimedRun,
} from "./helpers/guard-timing";

const BOUNDS = { matchMs: 150, workMs: 300, rawMs: MAX_RAW_SCRIPT_MS };
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
    execCommands: [],
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

// firstWithinBounds logs every rejected attempt; keep that out of the suite output, where the
// attempt counts of the real rows are the evidence.
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("guard timing helper: first run within bounds", () => {
  it("logs each rejected attempt with the bound it broke", async () => {
    const seq = sequence([
      run({ matchMs: 400 }),
      new GuardKilledError(HANG_KILL_MS, "SIGTERM"),
      run(),
    ]);
    const result = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(result.attempts).toBe(3);
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
      "guard timing attempt 1 rejected: matchMs 400.0 >= 150",
      "guard timing attempt 2 rejected: guard killed after 10000 ms wall (signal SIGTERM)",
    ]);
  });

  it("matchesDeterministic compares status, calls and execCalls", () => {
    expect(matchesDeterministic(run(), EXPECTED)).toBe(true);
    expect(matchesDeterministic(run({ status: 2 }), EXPECTED)).toBe(false);
    expect(matchesDeterministic(run({ calls: 9 }), EXPECTED)).toBe(false);
    expect(matchesDeterministic(run({ execCalls: 1 }), EXPECTED)).toBe(false);
  });

  it("matchesDeterministic pins the recorded execSync commands to the guard's git call", () => {
    const one = { ...EXPECTED, execCalls: 1 };
    const git = run({ execCalls: 1, execCommands: [GUARD_EXEC_COMMAND] });
    expect(GUARD_EXEC_COMMAND).toBe("git rev-parse --abbrev-ref HEAD");
    expect(matchesDeterministic(git, one)).toBe(true);
    expect(matchesDeterministic(run({ execCalls: 1, execCommands: ["sleep 4"] }), one)).toBe(false);
    expect(
      matchesDeterministic(run({ execCalls: 1, execCommands: [`${GUARD_EXEC_COMMAND} x`] }), one),
    ).toBe(false);
    // Rows that expect no exec keep asserting none.
    expect(matchesDeterministic(run({ execCommands: [GUARD_EXEC_COMMAND] }), EXPECTED)).toBe(false);
  });

  it("withinBounds checks match time and script time minus waits, not wall time", () => {
    expect(withinBounds(run(), BOUNDS)).toBe(true);
    expect(withinBounds(run({ matchMs: 150 }), BOUNDS)).toBe(false);
    expect(withinBounds(run({ scriptMs: 400, stdinIdleMs: 0 }), BOUNDS)).toBe(false);
    // Idle stdin wait and execSync are subtracted before the script bound applies.
    expect(withinBounds(run({ scriptMs: 400, stdinIdleMs: 150, execMs: 100 }), BOUNDS)).toBe(true);
    // Wall time is process start under load, not guard work: a 3950 ms wall with 76 ms of work passes.
    expect(withinBounds(run({ wallMs: 3950, scriptMs: 80, stdinIdleMs: 5 }), BOUNDS)).toBe(true);
    expect(withinBounds(run({ wallMs: HANG_KILL_MS - 1 }), BOUNDS)).toBe(true);
  });

  it("violations names each broken bound with its numbers", () => {
    expect(violations(run(), BOUNDS)).toEqual([]);
    expect(violations(run({ matchMs: 200 }), BOUNDS)).toEqual(["matchMs 200.0 >= 150"]);
    expect(violations(run({ scriptMs: 400, stdinIdleMs: 0 }), BOUNDS)).toEqual([
      "workMs 400.0 >= 300",
    ]);
    expect(violations(run({ matchMs: 150, scriptMs: 400, stdinIdleMs: 0 }), BOUNDS)).toHaveLength(
      2,
    );
  });

  it("raw time bounds idle too: a guard idle before it reads stdin fails", () => {
    // 6 s idle before the read: workMs is 12 ms, the old bounds pass, the raw bound does not.
    // Idle time is all but 12 ms of the script time, so only the raw bound can see it.
    const idleRun = (scriptMs: number): TimedRun => run({ scriptMs, stdinIdleMs: scriptMs - 12 });
    const idle = run({ scriptMs: 6014, stdinWaitMs: 6002, stdinIdleMs: 6002 });
    expect(workMs(idle)).toBeLessThan(BOUNDS.workMs);
    expect(violations(idle, BOUNDS)).toEqual(["rawMs 6014.0 >= 3000"]);
    expect(withinBounds(idleRun(MAX_RAW_SCRIPT_MS - 1), BOUNDS)).toBe(true);
    expect(withinBounds(idleRun(MAX_RAW_SCRIPT_MS), BOUNDS)).toBe(false);
    // An async exec awaited before the read looks the same (execMs only counts execSync).
    const exec = run({ scriptMs: 4500, stdinIdleMs: 4400, execMs: 50, execCalls: 0 });
    expect(withinBounds(exec, BOUNDS)).toBe(false);
  });

  it("rawMs leaves out execSync only: a slow git rev-parse passes, the same time idle does not", () => {
    // 3.3 s in the guard's own execSync (seen on a heavily loaded runner) is input independent.
    const slowGit = run({ scriptMs: 3400, stdinIdleMs: 1, execMs: 3300, execCalls: 1 });
    expect(rawMs(slowGit)).toBe(100);
    expect(withinBounds(slowGit, BOUNDS)).toBe(true);
    expect(withinBounds({ ...slowGit, execMs: 0, execCalls: 0 }, BOUNDS)).toBe(false);
  });

  it("retries a run that only breaks the raw bound, and fails after all attempts", async () => {
    const idle = run({ scriptMs: 6014, stdinIdleMs: 6002 });
    const ok = await firstWithinBounds(sequence([idle, run()]).runOnce, EXPECTED, BOUNDS);
    expect(ok.attempts).toBe(2);
    const seq = sequence([idle, run({ scriptMs: 4000, stdinIdleMs: 3990 }), idle]);
    const failed = await firstWithinBounds(seq.runOnce, EXPECTED, BOUNDS);
    expect(failed.attempts).toBe(MAX_ATTEMPTS);
    expect(failed.run.scriptMs).toBe(4000);
    expect(withinBounds(failed.run, BOUNDS)).toBe(false);
  });

  it("a guard-side time of seconds fails whatever the kill limit is", () => {
    // 4.5 s of guard work (inside the 5 s hook timeout, so a real bypass window) is far over 300 ms.
    expect(withinBounds(run({ scriptMs: 4500, stdinIdleMs: 5 }), BOUNDS)).toBe(false);
    expect(HANG_KILL_MS).toBeGreaterThan(2 * 2500);
  });

  it("rowTimeoutMs covers attempts x spawns x (kill limit + slot wait)", () => {
    expect(rowTimeoutMs(1)).toBe(MAX_ATTEMPTS * (HANG_KILL_MS + SLOT_WAIT_MS));
    expect(rowTimeoutMs(2)).toBe(2 * rowTimeoutMs(1));
    expect(rowTimeoutMs(2, 1)).toBe(2 * (HANG_KILL_MS + SLOT_WAIT_MS));
    expect(rowTimeoutMs(6)).toBeGreaterThan(30_000); // the vitest default that a 6 spawn row hit
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

describe("guard timing helper: bound assertion for the CI retry runner", () => {
  it("passes a run within every bound", () => {
    expect(() => assertWithinBounds(run(), BOUNDS)).not.toThrow();
  });

  it("throws a TimingBoundError that starts with the classifier prefix and lists each bound", () => {
    const slow = run({ matchMs: 400, scriptMs: 4000 });
    let thrown: unknown;
    try {
      assertWithinBounds(slow, BOUNDS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TimingBoundError);
    const error = thrown as TimingBoundError;
    expect(error.name).toBe("TimingBoundError");
    expect(error.message.startsWith(TIMING_BOUND_PREFIX)).toBe(true);
    expect(error.message).toContain("matchMs 400.0 >= 150");
    expect(error.message).toContain("rawMs 4000.0 >= 3000");
  });

  it("does not turn a deterministic mismatch into a timing error", () => {
    const wrongExec = run({
      execCalls: 1,
      execCommands: ["git rev-parse --abbrev-ref HEAD && sleep 3"],
    });
    expect(matchesDeterministic(wrongExec, { ...EXPECTED, execCalls: 1 })).toBe(false);
    expect(() => assertWithinBounds(wrongExec, BOUNDS)).not.toThrow();
  });
});
