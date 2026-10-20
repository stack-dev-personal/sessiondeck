import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Keep the module cache (fastify, zod, better-sqlite3, contract) warm across files in a worker
    // instead of re-importing it per file: cold imports dominated CPU on small CI runners (R0.5 budget).
    // Every test builds its own store and app, and no src module holds cross-test state.
    isolate: false,
    maxWorkers: 4,
    // Slow shared runners (Windows CI) must not turn CPU starvation into spurious timeouts.
    testTimeout: 30_000,
  },
});
