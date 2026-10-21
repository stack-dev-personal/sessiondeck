import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Guards the CI steps that run the suites split out of the default run (R0.5): each must exist,
// run on both operating systems, and be unconditional and blocking.
const ciPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/ci.yml");

interface Step {
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
}
interface Workflow {
  jobs: { check: { strategy: { matrix: { os: string[] } }; steps: Step[] } };
}

const check = (parse(readFileSync(ciPath, "utf8")) as Workflow).jobs.check;

const REQUIRED_RUNS = [
  "pnpm -F @sessiondeck/scripts test:proc",
  "pnpm -F @sessiondeck/scripts test:guard-timing:ci",
  "pnpm -F @sessiondeck/scripts test:sprint",
  "pnpm -F @sessiondeck/probe test:proc",
  "pnpm -r test",
];

describe("ci.yml check job", () => {
  it("runs on ubuntu-latest and windows-latest", () => {
    expect(check.strategy.matrix.os).toEqual(
      expect.arrayContaining(["ubuntu-latest", "windows-latest"]),
    );
  });

  it.each(REQUIRED_RUNS)("has an unconditional, blocking step running `%s`", (run) => {
    const steps = check.steps.filter((step) => step.run === run);
    expect(steps).toHaveLength(1);
    expect(steps[0]).not.toHaveProperty("if");
    expect(steps[0]).not.toHaveProperty("continue-on-error");
  });
});
