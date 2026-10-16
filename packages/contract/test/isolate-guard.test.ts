import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest.config.ts runs the contract tests with `isolate: false` (R0.5), so files share a worker.
// That is safe only while no test leaks state across files. This guard enforces the rule.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = "isolate-guard.test.ts";

const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: "vi.mock", pattern: /\bvi\s*\.\s*(doMock|doUnmock|mock|unmock)\b/ },
  { name: "vi.spyOn", pattern: /\bvi\s*\.\s*spyOn\b/ },
  { name: "vi.stub*", pattern: /\bvi\s*\.\s*stub\w*/ },
  { name: "useFakeTimers", pattern: /\buseFakeTimers\b/ },
  { name: "process.env", pattern: /\bprocess\s*\.\s*env\b/ },
  { name: "process.chdir", pattern: /\bprocess\s*\.\s*chdir\b/ },
];

function contractTestFiles(): string[] {
  return readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && f !== SELF);
}

describe("isolate:false guard", () => {
  it("finds the contract test files to scan", () => {
    expect(contractTestFiles().length).toBeGreaterThan(10);
  });

  it.each(contractTestFiles().map((f) => [f]))("%s shares no global state", (file) => {
    const source = readFileSync(join(TEST_DIR, file), "utf8");
    for (const { name, pattern } of FORBIDDEN) {
      expect(
        pattern.test(source),
        `${file} uses ${name}; packages/contract runs with isolate:false, see vitest.config.ts`,
      ).toBe(false);
    }
  });

  it.each([
    ["vi.mock", 'vi.mock("node:fs")'],
    ["vi.mock", "vi.doMock('x', () => ({}))"],
    ["vi.spyOn", "vi.spyOn(console, 'log')"],
    ["vi.stub*", "vi.stubGlobal('x', 1)"],
    ["vi.stub*", "vi.stubEnv('A', 'b')"],
    ["useFakeTimers", "vi.useFakeTimers()"],
    ["process.env", "process.env.FOO = 'x'"],
    ["process.chdir", "process.chdir(dir)"],
  ])("the %s pattern matches the known-bad line %j", (name, line) => {
    const entry = FORBIDDEN.find((f) => f.name === name);
    expect(entry?.pattern.test(line)).toBe(true);
  });

  it.each(["const env = readEnv();", "expect(spy).toBe(1);", "const mocked = false;"])(
    "no pattern matches the known-good line %j",
    (line) => {
      expect(FORBIDDEN.some((f) => f.pattern.test(line))).toBe(false);
    },
  );
});
