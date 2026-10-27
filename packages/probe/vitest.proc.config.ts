import { defineConfig } from "vitest/config";

// Every suite that spawns the built entries (hook, statusline, subagents, probe CLI) EXCEPT the
// real-exe suites, which have their own config (vitest.proc.exe.config.ts) so the R1.3 exe stress
// runs alone instead of competing with the timing-dependent suites here.
export default defineConfig({
  test: {
    include: ["test/**/*.proc.test.ts"],
    exclude: ["test/*-exe*.proc.test.ts", "node_modules/**"],
    // Builds dist/*.mjs once before any test file runs, so a clean checkout works.
    globalSetup: ["test/global-setup.ts"],
    // Process-spawning tests are slow on Windows CI.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
