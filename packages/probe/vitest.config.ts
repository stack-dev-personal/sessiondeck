import { defineConfig } from "vitest/config";

// Fast in-process unit tests only: nothing here spawns a child process or needs dist/.
// Process-spawning suites (*.proc.test.ts) run through vitest.proc.config.ts (`pnpm test:proc`).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.proc.test.ts", "node_modules/**"],
  },
});
