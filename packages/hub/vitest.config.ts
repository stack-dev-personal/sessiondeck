import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 4,
    // Slow shared runners (Windows CI) must not turn CPU starvation into spurious timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
