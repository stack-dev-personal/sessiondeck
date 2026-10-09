import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests spawn real node processes; Windows process start-up is slow under load.
    testTimeout: 30_000,
  },
});
