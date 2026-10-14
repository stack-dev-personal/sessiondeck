import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers";
import { SPRINT_SCRIPTS } from "./fixtures/sprint-ps/harness";

const LIB = join(SPRINT_SCRIPTS, "lib");
const SCRIPT_FILES = [
  join(SPRINT_SCRIPTS, "run-sprint.ps1"),
  join(SPRINT_SCRIPTS, "status.ps1"),
  join(SPRINT_SCRIPTS, "stop-sprint.ps1"),
  ...readdirSync(LIB)
    .filter((f) => f.endsWith(".ps1"))
    .map((f) => join(LIB, f)),
];

describe("sprint PowerShell sources", () => {
  it("are plain ASCII with LF endings and no byte order mark", () => {
    for (const file of SCRIPT_FILES) {
      const bytes = readFileSync(file);
      expect(
        bytes.every((b) => b < 0x80),
        file,
      ).toBe(true);
      expect(bytes.includes(13), file).toBe(false);
    }
  });

  it("avoid syntax that Windows PowerShell 5.1 cannot parse", () => {
    for (const file of SCRIPT_FILES) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      expect(code, file).not.toMatch(/\?\?|&&|\|\||\?\.|\s\?\s.*\s:\s/);
    }
  });

  it("use strict mode and stop on errors", () => {
    for (const file of SCRIPT_FILES.filter((f) => !f.includes("lib"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain("Set-StrictMode -Version Latest");
      expect(text, file).toContain("$ErrorActionPreference = 'Stop'");
    }
  });

  it("have no switch for choosing the docker binary and never read the env file", () => {
    for (const file of SCRIPT_FILES) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/FAKE|DOCKER_BIN|s-DockerBinary|s-DockerPath/i);
      expect(text, file).not.toMatch(/Get-FileHash|Copy-Item/);
    }
    const envWork = readFileSync(join(LIB, "sprint-envfile.ps1"), "utf8");
    expect(envWork).not.toMatch(/Get-Content|ReadAllText|ReadAllBytes|OpenRead|StreamReader/);
    expect(readFileSync(join(SPRINT_SCRIPTS, "run-sprint.ps1"), "utf8")).not.toMatch(
      /Get-Content|ReadAllText|ReadAllBytes|OpenRead|StreamReader/,
    );
  });

  it("create the same state subdirectories as the contract package", () => {
    const contract = readFileSync(
      join(REPO_ROOT, "packages", "contract", "src", "state-file-paths.ts"),
      "utf8",
    );
    const block = contract.match(/STATE_SUBDIRS = \{([\s\S]*?)\} as const/)![1]!;
    const wanted = [...block.matchAll(/:\s*"([a-z]+)"/g)].map((m) => m[1]!).sort();
    const script = readFileSync(join(SPRINT_SCRIPTS, "run-sprint.ps1"), "utf8");
    const listed = script.match(/\$StateSubdirs = @\(([^)]*)\)/)![1]!;
    const have = [...listed.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort();
    expect(have).toEqual(wanted);
  });
});
