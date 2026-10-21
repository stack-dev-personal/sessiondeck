import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { MAX_WORKERS, PROC_TESTS } from "./vitest.config.ts";

// The process-spawning suites (guard hook, capture and install scripts, fixture tools); see
// vitest.config.ts for the rule that splits them from the default run.
export default defineConfig({
  test: {
    // Same worker count as the default run: these files wait on child processes, so 2 x cores.
    maxWorkers: Math.min(MAX_WORKERS, availableParallelism() * 2),
    include: PROC_TESTS,
    pool: "threads",
    // Each file starts real node processes; Windows process start-up is slow under load.
    testTimeout: 60_000,
  },
});
