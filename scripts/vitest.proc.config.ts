import { defineConfig } from "vitest/config";
import { PROC_TESTS } from "./vitest.config.ts";

// The process-spawning suites (guard hook, capture and install scripts, fixture tools); see
// vitest.config.ts for the rule that splits them from the default run.
export default defineConfig({
  test: {
    include: PROC_TESTS,
    pool: "threads",
    // Each file starts real node processes; Windows process start-up is slow under load.
    testTimeout: 60_000,
  },
});
