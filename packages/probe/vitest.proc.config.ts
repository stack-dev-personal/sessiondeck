import { defineConfig } from "vitest/config";

// Every suite that spawns the built entries (hook, statusline, subagents, probe CLI).
export default defineConfig({
  test: {
    include: ["test/**/*.proc.test.ts"],
    // Builds dist/*.mjs once before any test file runs, so a clean checkout works.
    globalSetup: ["test/global-setup.ts"],
    // Process-spawning tests are slow on Windows CI.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
