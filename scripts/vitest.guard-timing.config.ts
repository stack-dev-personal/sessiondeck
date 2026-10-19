import { defineConfig } from "vitest/config";
import { GUARD_TIMING_TESTS } from "./vitest.config.ts";

// The guard timing tests (see vitest.config.ts for the rule that splits them from the default run).
// Run with `pnpm test:guard-timing`, or `pnpm test:guard-timing:ci` for the CI step with bounded
// retries of timing failures (scripts/ci/guard-timing-retry.mjs).
export default defineConfig({
  test: {
    include: [GUARD_TIMING_TESTS],
    // Files run one after the other. The spawn slots (TIMING_SLOTS in test/helpers/guard-timing.ts)
    // are per module instance, so two files in two workers would run twice the concurrent guard
    // processes the bounds were measured with. Within a file the rows still run concurrently.
    fileParallelism: false,
    pool: "threads",
    // Rows and self-tests set their own timeouts (rowTimeoutMs); this covers the helper tests.
    testTimeout: 30_000,
  },
});
