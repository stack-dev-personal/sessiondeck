import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import defaultConfig, {
  GUARD_TIMING_TESTS,
  PROC_TESTS,
  SPRINT_TOOLING_TESTS,
} from "../vitest.config";
import guardTimingConfig from "../vitest.guard-timing.config";
import procConfig from "../vitest.proc.config";
import sprintConfig from "../vitest.sprint.config";

// Guards the split between four runs: the default run (R0.5 budget), the process-spawning run (FIX-5),
// the sprint tooling run and the guard timing run (conductor decision 13). Every test file must be in exactly one of them.
// Each config must use the same glob as the default run's exclude list.
const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPRINT_GLOB = "test/sprint-*.test.ts";
const GUARD_TIMING_GLOB = "test/guard-timing*.test.ts";
const NODE_MODULES_GLOB = "**/node_modules/**";

/** Matches a single-directory glob whose only wildcard is `*`; throws on anything fancier. */
function globToRegExp(glob: string): RegExp {
  if (/[?[\]{}()!+@]|\*\*/.test(glob)) throw new Error(`unsupported glob: ${glob}`);
  const escaped = glob.replace(/[.\\^$|]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function testFiles(): string[] {
  return readdirSync(join(scriptsDir, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/${name}`);
}

const defaultExclude = defaultConfig.test?.exclude ?? [];
const sprintInclude = sprintConfig.test?.include ?? [];
const guardTimingInclude = guardTimingConfig.test?.include ?? [];
const procInclude = procConfig.test?.include ?? [];

type RunName = "default" | "sprint" | "guard-timing" | "proc";

/** Every run whose config selects the file. A file must have exactly one. */
function runsOf(file: string): RunName[] {
  const excluded = defaultExclude.filter((glob) => glob !== NODE_MODULES_GLOB).map(globToRegExp);
  const runs: RunName[] = [];
  if (!excluded.some((re) => re.test(file))) runs.push("default");
  if (sprintInclude.map(globToRegExp).some((re) => re.test(file))) runs.push("sprint");
  if (guardTimingInclude.map(globToRegExp).some((re) => re.test(file))) runs.push("guard-timing");
  if (procInclude.map(globToRegExp).some((re) => re.test(file))) runs.push("proc");
  return runs;
}

describe("test split (default run vs sprint tooling run vs guard timing run)", () => {
  it("uses the same glob in each config, and nothing else is excluded or included", () => {
    expect(SPRINT_TOOLING_TESTS).toBe(SPRINT_GLOB);
    expect(GUARD_TIMING_TESTS).toBe(GUARD_TIMING_GLOB);
    expect(defaultExclude).toEqual([
      NODE_MODULES_GLOB,
      SPRINT_GLOB,
      GUARD_TIMING_GLOB,
      ...PROC_TESTS,
    ]);
    expect(procInclude).toEqual(PROC_TESTS);
    expect(sprintInclude).toEqual([SPRINT_GLOB]);
    expect(guardTimingInclude).toEqual([GUARD_TIMING_GLOB]);
  });

  it("has a default include that covers every test file", () => {
    expect(defaultConfig.test?.include).toEqual(["test/**/*.test.ts"]);
  });

  it("puts every test file in exactly one run", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const runs = runsOf(file);
      expect(runs.length, `${file}: runs=${runs.join(",") || "none"}`).toBe(1);
    }
  });

  it("sends sprint-* files to the sprint run, guard-timing* files to the guard timing run", () => {
    const files = testFiles();
    const sprint = files.filter((file) => runsOf(file)[0] === "sprint");
    const timing = files.filter((file) => runsOf(file)[0] === "guard-timing");
    expect(sprint.length).toBeGreaterThan(0);
    expect(sprint.every((file) => globToRegExp(SPRINT_GLOB).test(file))).toBe(true);
    expect(timing).toContain("test/guard-timing.test.ts");
    expect(timing).toContain("test/guard-timing-helper.test.ts");
    expect(timing.every((file) => globToRegExp(GUARD_TIMING_GLOB).test(file))).toBe(true);
    expect(files.filter((file) => runsOf(file)[0] === "default").length).toBeGreaterThan(0);
  });

  it("keeps the retry classifier tests in the default run and the hook-spawning guard tests in the proc run", () => {
    expect(runsOf("test/guard-rules.test.ts")).toEqual(["proc"]);
    expect(runsOf("test/guard-retry-classify.test.ts")).toEqual(["default"]);
    expect(runsOf("test/test-split.test.ts")).toEqual(["default"]);
  });

  it("keeps the suite that spawns the transcript inventory script in the proc run", () => {
    expect(runsOf("test/transcript-inventory.test.ts")).toEqual(["proc"]);
    expect(runsOf("test/transcript-review-fixes.test.ts")).toEqual(["default"]);
  });

  it("lists only existing test files in the proc run, each exactly once", () => {
    const files = testFiles();
    expect(new Set(PROC_TESTS).size).toBe(PROC_TESTS.length);
    for (const file of PROC_TESTS) expect(files, file).toContain(file);
    expect(files.filter((file) => runsOf(file)[0] === "proc").sort()).toEqual(
      [...PROC_TESTS].sort(),
    );
  });

  it("matches the globs the way the configs do", () => {
    const sprint = globToRegExp(SPRINT_GLOB);
    expect(sprint.test("test/sprint-x.test.ts")).toBe(true);
    expect(sprint.test("test/sprint/x.test.ts")).toBe(false);
    expect(sprint.test("test/not-sprint-x.test.ts")).toBe(false);
    const timing = globToRegExp(GUARD_TIMING_GLOB);
    expect(timing.test("test/guard-timing.test.ts")).toBe(true);
    expect(timing.test("test/guard-timing-growth.test.ts")).toBe(true);
    expect(timing.test("test/guard-timing-helper.test.ts")).toBe(true);
    expect(timing.test("test/guard-growth.test.ts")).toBe(false);
    expect(timing.test("test/guard-rules.test.ts")).toBe(false);
    expect(timing.test("test/guard-retry-classify.test.ts")).toBe(false);
    expect(timing.test("test/guard-timing/x.test.ts")).toBe(false);
  });

  it("rejects globs the matcher cannot evaluate", () => {
    expect(() => globToRegExp("test/**/*.test.ts")).toThrow(/unsupported glob/);
  });
});
