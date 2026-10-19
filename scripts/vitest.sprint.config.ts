import { defineConfig } from "vitest/config";
import { SPRINT_TOOLING_TESTS } from "./vitest.config.ts";

// All sprint tooling tests (renderer, image static checks, PowerShell scripts); see
// vitest.config.ts for the rule that splits them from the default run.
export default defineConfig({
  test: {
    include: [SPRINT_TOOLING_TESTS],
    // Each PowerShell test starts real PowerShell processes; Windows runners are slow.
    testTimeout: 60_000,
    // Lets the worker answer vitest's reporter updates between the long synchronous PowerShell
    // batches; without it vitest exits 1 on a worker RPC timeout with every test passing.
    setupFiles: ["./test/sprint-yield-setup.ts"],
  },
});
