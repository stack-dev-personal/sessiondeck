import { defineConfig } from "vitest/config";

// The suites that run the Bun-compiled exes (hook, statusline, subagents). One file at a time, so
// the R1.3 exe stress and the exe installs never share CPU with each other or with test:proc.
export default defineConfig({
  test: {
    include: ["test/*-exe*.proc.test.ts"],
    fileParallelism: false,
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
