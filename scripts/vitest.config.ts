import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// One rule: every test/sprint-*.test.ts file is a sprint tooling test. They run in their own
// step (vitest.sprint.config.ts, `pnpm test:sprint`) so the default run stays inside the
// R0.5 one-minute budget. The sprint config includes this same glob.
export const SPRINT_TOOLING_TESTS = "test/sprint-*.test.ts";

// More workers than this only adds contention: the spawn-heavy files slow each other down. On a
// small CI box the default (cores - 1) is already lower, so the cap does not apply there.
export const MAX_WORKERS = 12;

export default defineConfig({
  test: {
    maxWorkers: Math.min(MAX_WORKERS, Math.max(1, availableParallelism() - 1)),
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", SPRINT_TOOLING_TESTS],
    // Worker threads start about 1.3 s of wall time faster than forked processes on this laptop and
    // use less CPU, which matters when contract's tests share the same 4 CI cores (R0.5). Measured:
    // forks 7.2 to 7.9 s, threads 5.7 to 6.3 s Duration for this package.
    pool: "threads",
    // A few tests spawn real node processes; Windows process start-up is slow under load.
    testTimeout: 30_000,
  },
});
