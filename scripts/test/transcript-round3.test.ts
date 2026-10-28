// Synthetic input only: every name and path below is invented for these tests.
import { describe, expect, it } from "vitest";
import { discoverLiterals } from "../lib/transcript-scrub-literals.mjs";
import { isProjectName, ownProjectName, parseScrubFlags } from "../lib/transcript-scrub-own.mjs";
import {
  PRIVATE_COMMAND,
  isOutsideProject,
  isPrivateToolUse,
} from "../lib/transcript-scrub-private.mjs";

const P = "<HOME>/projects/<PROJECT_A>";
const host = (): string => "synthbox";

describe("private in-repo paths count as outside", () => {
  it.each([
    "packages/contract/fixtures/raw/01-x/session.jsonl",
    "./packages/contract/fixtures/raw/a.json",
    `${P}/packages/contract/fixtures/raw/a.json`,
    "raw/deny-words.txt",
    `${P}/packages/contract/fixtures/raw/deny-words.txt`,
    ".env",
    ".env.local",
    "./apps/web/.env.production",
    `${P}/.env`,
    "probe.json",
    `${P}/packages/probe/probe.json`,
    "packages\\contract\\fixtures\\raw\\a.json",
  ])("%s is outside", (p) => {
    expect(isOutsideProject(p)).toBe(true);
  });

  it.each([
    `${P}/packages/contract/src/index.ts`,
    "packages/contract/fixtures/Stop/01-a.json",
    "README.md",
    `${P}/docs/planning/01-architecture.md`,
  ])("%s stays inside", (p) => {
    expect(isOutsideProject(p)).toBe(false);
  });

  it("makes a Read of such a path private, and a shell command that names one", () => {
    expect(isPrivateToolUse("Read", { file_path: "packages/contract/fixtures/raw/a.json" })).toBe(
      true,
    );
    expect(isPrivateToolUse("Read", { file_path: `${P}/.env` })).toBe(true);
    expect(isPrivateToolUse("Bash", { command: "cat packages/contract/fixtures/raw/a.json" })).toBe(
      true,
    );
    expect(isPrivateToolUse("Bash", { command: "cat .env.local" })).toBe(true);
    expect(isPrivateToolUse("Bash", { command: "type probe.json" })).toBe(true);
    expect(isPrivateToolUse("Bash", { command: "head raw/deny-words.txt" })).toBe(true);
    expect(isPrivateToolUse("Read", { file_path: `${P}/packages/contract/src/index.ts` })).toBe(
      false,
    );
    expect(isPrivateToolUse("Bash", { command: "pnpm -r test" })).toBe(false);
  });

  it("does not take ordinary words that start with env as the env file", () => {
    expect(PRIVATE_COMMAND.test("echo .environment")).toBe(false);
    expect(PRIVATE_COMMAND.test("cat src/env.ts")).toBe(false);
  });
});

describe("git user.name with only short words", () => {
  const git =
    (name: string) =>
    (a: string[]): string =>
      ({
        "config user.email": "al.wu@corp.example",
        "config user.name": name,
        "remote get-url origin": "https://github.com/quillorg/thing.git",
      })[a.join(" ")] ?? "";

  it("counts a set name as present", () => {
    expect(discoverLiterals([], " ", git("Al Wu"), host).gitMissing).toEqual([]);
  });

  it("still reports an unset name", () => {
    expect(discoverLiterals([], " ", git(""), host).gitMissing).toEqual(["git user.name"]);
  });

  it("sweeps the long words of a name that has some", () => {
    expect(discoverLiterals([], " ", git("Al Quillbert"), host).accounts).toContain("Quillbert");
  });
});

describe("parseScrubFlags", () => {
  it("reads both flags", () => {
    expect(
      parseScrubFlags(["--transcripts", "--no-git-literals", "--own-project", "demo"]),
    ).toEqual({ noGitLiterals: true, ownProject: "demo" });
  });

  it("defaults to the gate on and no own project", () => {
    expect(parseScrubFlags(["--transcripts"])).toEqual({ noGitLiterals: false });
  });

  it("ignores a missing or empty --own-project value", () => {
    expect(parseScrubFlags(["--own-project"])).toEqual({ noGitLiterals: false });
    expect(parseScrubFlags(["--own-project", ""])).toEqual({ noGitLiterals: false });
  });
});

describe("ownProjectName", () => {
  it("returns this repository's folder name, valid as a project name", () => {
    const name = ownProjectName();
    expect(name).not.toBe("");
    expect(isProjectName(name)).toBe(true);
  });
});
