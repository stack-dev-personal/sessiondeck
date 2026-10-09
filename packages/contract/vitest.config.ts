import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text"],
      // DoD: 100% line coverage on envelope.ts and state.ts.
      thresholds: {
        "src/envelope.ts": { lines: 100 },
        "src/state.ts": { lines: 100 },
      },
    },
  },
});
