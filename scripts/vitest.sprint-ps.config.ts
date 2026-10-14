import { defineConfig } from "vitest/config";
import { SPRINT_PS_SPAWNING_TESTS } from "./vitest.config.ts";

// Only the sprint script tests that spawn PowerShell; see vitest.config.ts.
export default defineConfig({
  test: {
    include: SPRINT_PS_SPAWNING_TESTS,
    // Each test starts real PowerShell processes; Windows runners are slow.
    testTimeout: 60_000,
  },
});
