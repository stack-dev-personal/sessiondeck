import { defineConfig } from "vitest/config";

const FULL = { lines: 100 };

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text"],
      // DoD: 100% line coverage on envelope.ts and state.ts, and on every file the reducer is built from.
      thresholds: {
        "src/envelope.ts": FULL,
        "src/state.ts": FULL,
        "src/state-names.ts": FULL,
        "src/transitions.ts": FULL,
        "src/event-fields.ts": FULL,
        "src/payload.ts": FULL,
        "src/liveness.ts": FULL,
        "src/limits.ts": FULL,
        "src/tracking.ts": FULL,
        "src/diagram.ts": FULL,
        "src/docblocks.ts": FULL,
      },
    },
  },
});
