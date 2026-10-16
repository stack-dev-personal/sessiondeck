import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// One rule: every test/sprint-*.test.ts file is a sprint tooling test. They run in their own
// step (vitest.sprint.config.ts, `pnpm test:sprint`) so the default run stays inside the
// R0.5 one-minute budget. The sprint config includes this same glob.
export const SPRINT_TOOLING_TESTS = "test/sprint-*.test.ts";

// Most of these files wait on child processes and the file system, so on a small box more workers
// than cores keep the CPU busy: 2 x cores beat cores - 1 by 1.5 s with contract running at the same
// time on 4 cores (2 workers 16.1 s, 3 workers 14.3 s, 4 to 8 workers 13.1 s proxy wall). More than
// this cap only adds contention on a big laptop.
export const MAX_WORKERS = 12;

export default defineConfig({
  test: {
    maxWorkers: Math.min(MAX_WORKERS, availableParallelism() * 2),
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
