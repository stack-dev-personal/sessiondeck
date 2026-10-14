import { defineConfig } from "vitest/config";

// The files that spawn PowerShell run in their own step (vitest.sprint-ps.config.ts,
// `pnpm test:sprint-ps`) so the default run stays inside the R0.5 one-minute budget.
export const SPRINT_PS_SPAWNING_TESTS = [
  "test/sprint-ps-run.test.ts",
  "test/sprint-ps-stop-status.test.ts",
  "test/sprint-ps-smoke.test.ts",
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ...SPRINT_PS_SPAWNING_TESTS],
    // Tests spawn real node processes; Windows process start-up is slow under load.
    testTimeout: 30_000,
  },
});
