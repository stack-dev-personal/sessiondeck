import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 2, // half of a 4-core runner shared with two other suites (R0.5)
    // Share the module graph (fastify, pino, ws, sqlite) across files in a worker: collect cost
    // dominated the suite on the 4-core runner (R0.5). Tests build their own app and store.
    isolate: false,
    setupFiles: ["test/support/fast-sqlite.ts"],
    // Slow shared runners (Windows CI) must not turn CPU starvation into spurious timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
