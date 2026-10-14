import { defineConfig } from "vitest/config";

// One rule: every test/sprint-*.test.ts file is a sprint tooling test. They run in their own
// step (vitest.sprint.config.ts, `pnpm test:sprint`) so the default run stays inside the
// R0.5 one-minute budget. The sprint config includes this same glob.
export const SPRINT_TOOLING_TESTS = "test/sprint-*.test.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", SPRINT_TOOLING_TESTS],
    // Tests spawn real node processes; Windows process start-up is slow under load.
    testTimeout: 30_000,
  },
});
