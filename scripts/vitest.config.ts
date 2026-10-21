import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// One rule: every test/sprint-*.test.ts file is a sprint tooling test. They run in their own
// step (vitest.sprint.config.ts, `pnpm test:sprint`) so the default run stays inside the
// R0.5 one-minute budget. The sprint config includes this same glob.
export const SPRINT_TOOLING_TESTS = "test/sprint-*.test.ts";

// Second rule: every test/guard-timing*.test.ts file bounds the guard hook's own run time
// (matchMs, workMs, rawMs, growth ratios) and runs in its own CI step (vitest.guard-timing.config.ts,
// `pnpm test:guard-timing:ci`), outside the R0.5 budget, with bounded retries of timing failures
// only (conductor decision 13). The functional guard rule tests (guard-rules.test.ts) spawn the hook and are in PROC_TESTS. The classifier of those retries is guard-retry-classify.test.ts, which is NOT
// guard-timing* and so stays in the default run too.
export const GUARD_TIMING_TESTS = "test/guard-timing*.test.ts";

// Third rule: the suites that start real node processes (about 66 spawns: guard hook, capture and
// install scripts, fixture tools) run in their own CI step (vitest.proc.config.ts,
// `pnpm test:proc`), outside the R0.5 budget, as probe's `test:proc` does (FIX-5, user decision
// R0.5 option A). Each entry is an exact file name; the other tests stay in-process in the default run.
export const PROC_TESTS = [
  "test/capture-entry.test.ts",
  "test/capture-fixtures.test.ts",
  "test/capture-hardening.test.ts",
  "test/capture-install.test.ts",
  "test/fixture-leak.test.ts",
  "test/fixture-scrub-keys.test.ts",
  "test/fixture-tools.test.ts",
  "test/guard-rules.test.ts",
  "test/install-deploy.test.ts",
  "test/install-guards.test.ts",
  "test/install-recognition.test.ts",
];

// Most of these files wait on child processes and the file system, so on a small box more workers
// than cores keep the CPU busy: 2 x cores beat cores - 1 by 1.5 s with contract running at the same
// time on 4 cores (2 workers 16.1 s, 3 workers 14.3 s, 4 to 8 workers 13.1 s proxy wall). More than
// this cap only adds contention on a big laptop.
export const MAX_WORKERS = 12;

export default defineConfig({
  test: {
    maxWorkers: Math.min(MAX_WORKERS, availableParallelism() * 2),
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", SPRINT_TOOLING_TESTS, GUARD_TIMING_TESTS, ...PROC_TESTS],
    // Worker threads start about 1.3 s of wall time faster than forked processes on this laptop and
    // use less CPU, which matters when contract's tests share the same 4 CI cores (R0.5). Measured:
    // forks 7.2 to 7.9 s, threads 5.7 to 6.3 s Duration for this package.
    pool: "threads",
    // A few tests spawn real node processes; Windows process start-up is slow under load.
    testTimeout: 30_000,
  },
});
