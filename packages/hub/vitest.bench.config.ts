import { defineConfig } from "vitest/config";

// R5.4 latency thresholds. Run on a non-contended host: `pnpm -F @sessiondeck/hub test:bench`.
export default defineConfig({
  test: {
    include: ["test/**/*.bench.test.ts"],
    setupFiles: ["test/support/fast-sqlite.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
