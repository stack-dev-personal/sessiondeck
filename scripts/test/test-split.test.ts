import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import defaultConfig, { SPRINT_TOOLING_TESTS } from "../vitest.config";
import sprintConfig from "../vitest.sprint.config";

// Guards the split between the default run (R0.5 budget) and the sprint tooling run: every
// test file must be in exactly one of them. Both configs must use the same glob.
const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_GLOB = "test/sprint-*.test.ts";
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

describe("test split (default run vs sprint tooling run)", () => {
  it("uses the sprint-* glob in both configs, and nothing else is excluded or included", () => {
    expect(SPRINT_TOOLING_TESTS).toBe(EXPECTED_GLOB);
    expect(defaultExclude).toEqual([NODE_MODULES_GLOB, EXPECTED_GLOB]);
    expect(sprintInclude).toEqual([EXPECTED_GLOB]);
  });

  it("has a default include that covers every test file", () => {
    expect(defaultConfig.test?.include).toEqual(["test/**/*.test.ts"]);
  });

  it("puts every test file in exactly one run", () => {
    const excluded = defaultExclude.filter((glob) => glob !== NODE_MODULES_GLOB).map(globToRegExp);
    const included = sprintInclude.map(globToRegExp);
    const files = testFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const inDefault = !excluded.some((re) => re.test(file));
      const inSprint = included.some((re) => re.test(file));
      expect(inDefault !== inSprint, `${file}: default=${inDefault} sprint=${inSprint}`).toBe(true);
    }
  });

  it("sends sprint-* files to the sprint run and nothing else", () => {
    const sprint = globToRegExp(EXPECTED_GLOB);
    const files = testFiles();
    expect(files.filter((f) => sprint.test(f)).length).toBeGreaterThan(0);
    expect(files.filter((f) => !sprint.test(f)).length).toBeGreaterThan(0);
    expect(sprint.test("test/sprint-x.test.ts")).toBe(true);
    expect(sprint.test("test/sprint/x.test.ts")).toBe(false);
    expect(sprint.test("test/not-sprint-x.test.ts")).toBe(false);
  });

  it("rejects globs the matcher cannot evaluate", () => {
    expect(() => globToRegExp("test/**/*.test.ts")).toThrow(/unsupported glob/);
  });
});
