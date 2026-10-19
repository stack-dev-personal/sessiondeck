import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED, BLOCKED, guardPath, repoRoot } from "./helpers/guard-run";
import {
  assertGrowthWithinBounds,
  BIG_RUN_FACTOR,
  bigRunWithin,
  firstGrowthWithin,
  GROWTH_FLOOR_MS,
  GROWTH_SCALE,
  growthRatio,
  growthViolations,
  growthWithin,
  MAX_GROWTH_RATIO,
  type GrowthPair,
} from "./helpers/guard-growth";
import {
  GUARD_EXEC_COMMAND,
  GuardKilledError,
  HANG_KILL_MS,
  MAX_ATTEMPTS,
  MAX_RAW_SCRIPT_MS,
  rawMs,
  rowTimeoutMs,
  runTimed,
  TimingBoundError,
  workMs,
  type TimedRun,
} from "./helpers/guard-timing";

const MAX_MATCH_MS = 150;
const MAX_SCRIPT_MS = 300;
const LIMITS = { matchMs: MAX_MATCH_MS, workMs: MAX_SCRIPT_MS, rawMs: MAX_RAW_SCRIPT_MS };
const BS = "\\";
const FIXTURE = resolve(
  repoRoot,
  "scripts",
  "test",
  "fixtures",
  "guard-timing",
  "regex-fixture.mjs",
);
const SIZE = 100_000;

function run(overrides: Partial<TimedRun> = {}): TimedRun {
  return {
    status: ALLOWED,
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

function pairOf(smallMs: number, bigMs: number, status = ALLOWED): GrowthPair {
  return { small: run({ matchMs: smallMs, status }), big: run({ matchMs: bigMs, status }) };
}

/** A runPair that serves the given pairs in order (the last one repeats) and counts its calls. */
function sequence(pairs: readonly (GrowthPair | Error)[]): {
  runPair: () => Promise<GrowthPair>;
  count: () => number;
} {
  let calls = 0;
  return {
    runPair: () => {
      const next = pairs[Math.min(calls, pairs.length - 1)];
      calls += 1;
      if (next === undefined) {
        return Promise.reject(new Error("sequence needs at least one pair"));
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    count: () => calls,
  };
}

describe("guard growth helper", () => {
  // firstGrowthWithin logs every rejected attempt; keep that out of the suite output, where the
  // attempt counts of the real rows are the evidence.
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clamps a small match time to the 3 ms floor", () => {
    expect(GROWTH_FLOOR_MS).toBe(3);
    expect(growthRatio(0.2, 6)).toBe(2);
    expect(growthRatio(10, 160)).toBe(16);
    expect(growthRatio(10, 160)).toBeGreaterThan(MAX_GROWTH_RATIO);
    expect(growthRatio(1, 1.5)).toBeLessThan(MAX_GROWTH_RATIO);
  });

  it("a linear shape with a 1 ms small run passes up to a 23 ms large run (the 1 ms floor failed at 8)", () => {
    expect(growthWithin(pairOf(1, 7.4), LIMITS)).toBe(true);
    expect(growthWithin(pairOf(0.4, 12), LIMITS)).toBe(true);
    expect(growthWithin(pairOf(1, 24), LIMITS)).toBe(false);
  });

  it("growthWithin checks the ratio, the small run limits and the large run bounds", () => {
    expect(growthWithin(pairOf(1, 4), LIMITS)).toBe(true);
    expect(growthWithin(pairOf(10, 100), LIMITS)).toBe(false);
    expect(growthWithin({ ...pairOf(1, 4), small: run({ matchMs: 200 }) }, LIMITS)).toBe(false);
    expect(
      growthWithin(
        { ...pairOf(1, 4), small: run({ scriptMs: 900, stdinIdleMs: 0, matchMs: 1 }) },
        LIMITS,
      ),
    ).toBe(false);
    // Wall time is process start under load, not guard work: it is not a bound.
    expect(growthWithin({ ...pairOf(1, 4), big: run({ matchMs: 4, wallMs: 5000 }) }, LIMITS)).toBe(
      true,
    );
  });

  it("growthViolations names every broken bound with its numbers", () => {
    expect(growthViolations(pairOf(1, 4), LIMITS)).toEqual([]);
    expect(growthViolations(pairOf(10, 100), LIMITS)).toEqual(["ratio 10.00 >= 8"]);
    const worst = growthViolations(
      {
        small: run({ matchMs: 200, scriptMs: 900, stdinIdleMs: 0 }),
        big: run({ matchMs: 400, scriptMs: 700, stdinIdleMs: 0 }),
      },
      LIMITS,
    );
    expect(worst).toEqual([
      "small matchMs 200.0 >= 150",
      "small workMs 900.0 >= 300",
      "big matchMs 400.0 >= 300",
      "big workMs 700.0 >= 600",
    ]);
  });

  it("assertGrowthWithinBounds throws TimingBoundError for a bound failure and nothing for a good pair", () => {
    expect(() => assertGrowthWithinBounds(pairOf(1, 4), LIMITS)).not.toThrow();
    let thrown: unknown;
    try {
      assertGrowthWithinBounds(pairOf(10, 100), LIMITS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TimingBoundError);
    expect((thrown as Error).message).toBe("timing bound violated: ratio 10.00 >= 8");
    // The rawMs bound of the large run is retryable like the others.
    const idle = run({ scriptMs: 6014, stdinWaitMs: 6002, stdinIdleMs: 6002 });
    expect(() => assertGrowthWithinBounds({ small: run(), big: idle }, LIMITS)).toThrow(
      TimingBoundError,
    );
  });

  it("rejected attempts are logged with the bound they broke", async () => {
    const result = await firstGrowthWithin(
      sequence([pairOf(10, 100), pairOf(10, 20)]).runPair,
      ALLOWED,
      LIMITS,
    );
    expect(result.attempts).toBe(2);
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
      "guard growth attempt 1 rejected: ratio 10.00 >= 8",
    ]);
  });

  // The ratio alone is blind to these: each pair below has a ratio under MAX_GROWTH_RATIO and a
  // small run inside the limits, so only the large-run bounds can fail them (a later guard change
  // with non-regex work, or a quadratic part under half of the linear part, looks like this).
  const blindToRatio = (name: string, pair: GrowthPair): void => {
    expect(growthRatio(pair.small.matchMs, pair.big.matchMs), name).toBeLessThan(MAX_GROWTH_RATIO);
    expect(growthWithin(pair, LIMITS), name).toBe(false);
  };

  it("bounds the large run in match and script time (the ratio alone passes)", () => {
    expect(BIG_RUN_FACTOR).toBe(2);
    const calm = run({ matchMs: 100, scriptMs: 60, stdinIdleMs: 5 });
    blindToRatio("big matchMs", { small: calm, big: run({ matchMs: 2 * MAX_MATCH_MS }) });
    blindToRatio("big workMs", {
      small: calm,
      big: run({ scriptMs: 2 * MAX_SCRIPT_MS + 5, stdinIdleMs: 5, matchMs: 100 }),
    });
    expect(bigRunWithin(run({ matchMs: 2 * MAX_MATCH_MS - 1 }), LIMITS)).toBe(true);
    // Just inside every large-run bound passes.
    expect(
      growthWithin(
        {
          small: calm,
          big: run({
            matchMs: 2 * MAX_MATCH_MS - 1,
            scriptMs: 2 * MAX_SCRIPT_MS - 1,
            stdinIdleMs: 0,
            wallMs: HANG_KILL_MS - 1,
          }),
        },
        LIMITS,
      ),
    ).toBe(true);
    // Guard-side time of seconds fails even when the ratio and the wall time look calm.
    expect(
      growthWithin({ small: run({ scriptMs: 4500, stdinIdleMs: 5 }), big: run() }, LIMITS),
    ).toBe(false);
  });

  it("bounds rawMs of both runs: a guard that idles before reading stdin fails", () => {
    // 6 s idle before the read: workMs is 12 ms, so the work bounds and the ratio all pass.
    const idle = run({ scriptMs: 6014, stdinWaitMs: 6002, stdinIdleMs: 6002 });
    expect(workMs(idle)).toBeLessThan(MAX_SCRIPT_MS);
    expect(growthViolations({ small: idle, big: run() }, LIMITS)).toEqual([
      "small rawMs 6014.0 >= 3000",
    ]);
    expect(growthViolations({ small: run(), big: idle }, LIMITS)).toEqual([
      "big rawMs 6014.0 >= 3000",
    ]);
    expect(bigRunWithin(idle, LIMITS)).toBe(false);
    expect(growthWithin({ small: idle, big: idle }, LIMITS)).toBe(false);
    // execSync is not idle: a slow git call in the large run does not fail the raw bound.
    const slowGit = run({ scriptMs: 3500, stdinIdleMs: 1, execMs: 3400, execCalls: 1 });
    expect(bigRunWithin(slowGit, LIMITS)).toBe(true);
  });

  it("retries a pair that only violates a large-run bound, and fails if all attempts do", async () => {
    const slowBig = { small: run({ matchMs: 100 }), big: run({ matchMs: 2 * MAX_MATCH_MS }) };
    const retried = await firstGrowthWithin(
      sequence([slowBig, pairOf(20, 60)]).runPair,
      ALLOWED,
      LIMITS,
    );
    expect(retried.attempts).toBe(2);
    const failed = await firstGrowthWithin(sequence([slowBig]).runPair, ALLOWED, LIMITS);
    expect(failed.attempts).toBe(MAX_ATTEMPTS);
    expect(growthWithin(failed, LIMITS)).toBe(false);
  });

  it("RED demo with real runs: size independent slow work in the large run fails, the ratio passes", async () => {
    // The linear fixture is the small run; the slow-loop fixture (600 ms busy wait, no regex) is the
    // large run. matchMs stays under 1 ms for both, so the ratio is far under the limit and the old
    // check (ratio plus the small run's limits) passes; the large-run script bound (2 x 300 ms) fails.
    const small = await runTimed(FIXTURE, "linear", repoRoot);
    const big = await runTimed(FIXTURE, "slow-loop", repoRoot);
    expect(growthRatio(small.matchMs, big.matchMs)).toBeLessThan(MAX_GROWTH_RATIO);
    expect(small.matchMs).toBeLessThan(MAX_MATCH_MS);
    expect(workMs(small)).toBeLessThan(MAX_SCRIPT_MS);
    expect(workMs(big)).toBeGreaterThanOrEqual(2 * MAX_SCRIPT_MS);
    expect(growthWithin({ small, big }, LIMITS)).toBe(false);
  });

  it("stops after one attempt when the first pair is within bounds", async () => {
    const seq = sequence([pairOf(1, 3)]);
    const result = await firstGrowthWithin(seq.runPair, ALLOWED, LIMITS);
    expect(result.attempts).toBe(1);
    expect(seq.count()).toBe(1);
  });

  it("retries a pair whose ratio is too high and passes on a later attempt", async () => {
    const seq = sequence([pairOf(10, 100), pairOf(10, 20)]);
    const result = await firstGrowthWithin(seq.runPair, ALLOWED, LIMITS);
    expect(result.attempts).toBe(2);
    expect(result.kills).toBe(0);
    expect(result.ratio).toBe(2);
  });

  it("fails only when all attempts violate a bound, returning the worst pair", async () => {
    const seq = sequence([pairOf(10, 100), pairOf(10, 160), pairOf(10, 120)]);
    const result = await firstGrowthWithin(seq.runPair, ALLOWED, LIMITS);
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(seq.count()).toBe(MAX_ATTEMPTS);
    expect(result.ratio).toBe(16);
    expect(growthWithin(result, LIMITS)).toBe(false);
  });

  it("does not retry a status mismatch", async () => {
    const seq = sequence([pairOf(1, 3, BLOCKED), pairOf(1, 3)]);
    const result = await firstGrowthWithin(seq.runPair, ALLOWED, LIMITS);
    expect(result.attempts).toBe(1);
    expect(seq.count()).toBe(1);
    expect(result.small.status).toBe(BLOCKED);
  });

  it("counts a kill as a failed attempt and retries", async () => {
    const killed = new GuardKilledError(HANG_KILL_MS, "SIGTERM");
    const seq = sequence([killed, pairOf(1, 3)]);
    const result = await firstGrowthWithin(seq.runPair, ALLOWED, LIMITS);
    expect(result.attempts).toBe(2);
    expect(result.kills).toBe(1);
    const dead = sequence([killed]);
    await expect(firstGrowthWithin(dead.runPair, ALLOWED, LIMITS)).rejects.toThrow(/guard killed/);
    expect(dead.count()).toBe(MAX_ATTEMPTS);
  });

  it("rejects a maxAttempts below 1", async () => {
    await expect(
      firstGrowthWithin(sequence([pairOf(1, 3)]).runPair, ALLOWED, LIMITS, 0),
    ).rejects.toThrow(/at least 1/);
  });
});

describe("guard: growth at 4x the size (conductor decision 5)", () => {
  // A bound at one size passes a slowly growing quadratic, or an exponential driven by a small
  // count. Each shape runs at about 100k characters and at GROWTH_SCALE times that. The ratio is
  // computed on matchMs (regex time), not workMs: workMs at 5 to 12 ms is mostly process noise, and
  // it jumped to 41 to 61 ms while matchMs stayed at 0.4 to 1.5 ms. matchMs under 3 ms is clamped
  // to 3 ms. The 150 ms and 300 ms bounds apply to the small run; the large run gets 2 x those
  // (match and script time), because the ratio alone passes slow non-regex work
  // and a quadratic part under half of the linear part. A row passes on the first attempt within
  // bounds (at most 3).
  interface GrowthShape {
    readonly build: (size: number) => string;
    readonly small: number;
    readonly status: number;
    /** Exact regex call count of the guard for this shape (same at both sizes), when it is known. */
    readonly calls?: number;
    /** Exact execSync count (same at both sizes): the shapes never reach the bare-push git call. */
    readonly execCalls: number;
  }
  const chars = (unit: string): number => Math.floor(SIZE / unit.length);
  const PUSH = "git push ";
  // One unit of the continuation shape has a backslash-LF and a backslash-CRLF line.
  const CONT = `node capture-install ${BS}\nnode capture-install ${BS}\r\n`;
  const XNODE = "node --x=node ";
  // Node anchors used as option values, inside the 32-option window: the heaviest linear shapes.
  const NODE_VALUE_CONT = `${BS}\n -a ${BS}\n node`;
  const NODE_VALUE_EQ = " -a=yyyy/node";
  const growthShapes: Record<string, GrowthShape> = {
    "git push x N": {
      build: (n) => PUSH.repeat(n),
      small: chars(PUSH),
      status: ALLOWED,
      execCalls: 0,
      calls: 9,
    },
    "node capture-install backslash-LF and backslash-CRLF x N, flag in another segment": {
      build: (n) => `echo --apply; ${CONT.repeat(n)}`,
      small: chars(CONT),
      status: ALLOWED,
      execCalls: 0,
      calls: 12,
    },
    "node --x=node x N + capture-install --apply": {
      build: (n) => `${XNODE.repeat(n)}capture-install --apply`,
      small: chars(XNODE),
      status: BLOCKED,
      execCalls: 0,
      calls: 9,
    },
    "node + (backslash-LF -a backslash-LF node) x N": {
      build: (n) => `node${NODE_VALUE_CONT.repeat(n)}`,
      small: chars(NODE_VALUE_CONT),
      status: ALLOWED,
      execCalls: 0,
    },
    "node + ( -a=yyyy/node) x N": {
      build: (n) => `node${NODE_VALUE_EQ.repeat(n)}`,
      small: chars(NODE_VALUE_EQ),
      status: ALLOWED,
      execCalls: 0,
    },
    "options: node + --a b x k + node capture-install --apply": {
      build: (k) => `node ${"--a b ".repeat(k)}node scripts/capture-install.mjs --apply`,
      small: 16,
      status: BLOCKED,
      execCalls: 0,
    },
    "options: node + -a x backslash-newline x k + node capture-install --apply": {
      build: (k) => `node ${`-a x${BS}\n`.repeat(k)}node scripts/capture-install.mjs --apply`,
      small: 16,
      status: BLOCKED,
      execCalls: 0,
    },
  };
  // The option shapes are 244 characters at k=64 and are driven by the count, not the size.
  it.concurrent.each(Object.entries(growthShapes))(
    `match time at ${GROWTH_SCALE}x the size grows by less than ${MAX_GROWTH_RATIO}x: %s`,
    async (name, shape) => {
      const result = await firstGrowthWithin(
        async () => {
          const small = await runTimed(guardPath, shape.build(shape.small), repoRoot);
          const big = await runTimed(guardPath, shape.build(shape.small * GROWTH_SCALE), repoRoot);
          return { small, big };
        },
        shape.status,
        LIMITS,
      );
      const { small, big } = result;
      console.info(
        `guard growth ${name}: attempts ${result.attempts}, kills ${result.kills}, ` +
          `matchMs ${small.matchMs.toFixed(1)} -> ${big.matchMs.toFixed(1)}, ` +
          `rawMs ${rawMs(small).toFixed(1)} -> ${rawMs(big).toFixed(1)} (bound ${MAX_RAW_SCRIPT_MS}), execCalls ${small.execCalls} -> ${big.execCalls}, ` +
          `ratio ${result.ratio.toFixed(2)}, workMs ${workMs(small).toFixed(1)} -> ${workMs(big).toFixed(1)}, ` +
          `wall ${small.wallMs.toFixed(0)} -> ${big.wallMs.toFixed(0)} ms (not a bound)`,
      );
      // Deterministic outputs first, so a mismatch is never read as a timing failure and is never
      // retried. execCommands is pinned because execSync time is excluded from every time bound.
      const execCommands = Array(shape.execCalls).fill(GUARD_EXEC_COMMAND);
      expect(small.status).toBe(shape.status);
      expect(big.status).toBe(shape.status);
      expect(small.execCalls).toBe(shape.execCalls);
      expect(big.execCalls).toBe(shape.execCalls);
      expect(small.execCommands).toEqual(execCommands);
      expect(big.execCommands).toEqual(execCommands);
      if (shape.calls !== undefined) {
        expect(small.calls).toBe(shape.calls);
        expect(big.calls).toBe(shape.calls);
      }
      // Bounds last: ratio, the small run's limits, the large run's own bounds (the ratio cannot see
      // slow non-regex work or a quadratic part under half of the linear part) and rawMs of both runs
      // (idle time included). Only this error lets the CI step run the file again (see scripts/ci).
      assertGrowthWithinBounds(result, LIMITS);
    },
    // Two spawns per attempt, each waiting for a timing slot and killed at the hang limit.
    rowTimeoutMs(2),
  );
});
