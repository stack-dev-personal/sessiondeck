// Synthetic input only: every name, path and email below is invented for these tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRawSets } from "../lib/transcript-leak-raw.mjs";
import { discoverLiterals } from "../lib/transcript-scrub-literals.mjs";
import {
  gitLiteralProblem,
  isProjectName,
  ownProjectProblem,
} from "../lib/transcript-scrub-own.mjs";
import { runTranscripts, scrubFixture } from "../lib/transcript-scrub-run.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const FULL: Record<string, string> = {
  "config user.email": "quill.tester@corp.example",
  "config user.name": "Quillbert",
  "remote get-url origin": "https://github.com/quillorg/thing.git",
};
const fullGit = (args: string[]): string => FULL[args.join(" ")] ?? "";
const noGit = (): string => "";
const host = (): string => "synthbox";
const VOCAB = " ";

describe("git literal gate", () => {
  it("lists every empty git source and none when all three answer", () => {
    expect(discoverLiterals([], VOCAB, noGit).gitMissing).toEqual([
      "git user.email",
      "git user.name",
      "origin owner",
    ]);
    expect(discoverLiterals([], VOCAB, fullGit).gitMissing).toEqual([]);
  });

  it("reports one empty source on its own", () => {
    const git = (a: string[]): string => (a[1] === "user.name" ? "" : fullGit(a));
    expect(discoverLiterals([], VOCAB, git).gitMissing).toEqual(["git user.name"]);
  });

  it("treats an email without an address shape or an origin that is not a host URL as empty", () => {
    const git = (a: string[]): string =>
      a[1] === "user.email" ? "not an address" : a[0] === "remote" ? "/local/path" : fullGit(a);
    expect(discoverLiterals([], VOCAB, git).gitMissing).toEqual(["git user.email", "origin owner"]);
  });

  it("still sweeps the git name when the lookup works", () => {
    expect(discoverLiterals([], VOCAB, fullGit).accounts).toContain("Quillbert");
  });

  it("builds a message naming the sources, and none when opted out or nothing is missing", () => {
    const msg = gitLiteralProblem(["git user.name", "origin owner"], false);
    expect(msg).toContain("git user.name, origin owner");
    expect(msg).toContain("--no-git-literals");
    expect(gitLiteralProblem(["git user.name"], true)).toBeNull();
    expect(gitLiteralProblem([], false)).toBeNull();
  });

  it("carries the missing sources through the leak check's raw sets, only when raw/ exists", () => {
    expect(deriveRawSets(null, VOCAB, noGit, host).gitMissing).toEqual([]);
    const raw = makeTempDir();
    writeFileSync(join(raw, "a.jsonl"), `${JSON.stringify({ type: "user" })}\n`);
    expect(deriveRawSets(raw, VOCAB, noGit, host).gitMissing).toHaveLength(3);
    expect(deriveRawSets(raw, VOCAB, fullGit, host).gitMissing).toEqual([]);
  });
});

/** A raw tree with one fixture holding the given session rows. */
function rawWith(rows: unknown[]): { raw: string; out: string } {
  const raw = makeTempDir();
  const dir = join(raw, "transcripts", "01-synthetic");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return { raw, out: makeTempDir() };
}

const userRow = (cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "user",
  cwd,
  message: { role: "user", content: "hello" },
  ...extra,
});

describe("runTranscripts guards", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("returns 0 for a clean fixture", () => {
    const { raw, out } = rawWith([userRow("C:/Users/zed/projects/sessiondeck")]);
    expect(runTranscripts(raw, out, { ownProject: "sessiondeck", git: fullGit, host })).toBe(0);
  });

  it("returns 1 and lists the key path when a row has an unlisted key", () => {
    const { raw, out } = rawWith([
      userRow("C:/Users/zed/projects/sessiondeck", { zzUnlistedKey: "v" }),
    ]);
    const code = runTranscripts(raw, out, { ownProject: "sessiondeck", git: fullGit, host });
    expect(code).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors.some((e) => e.startsWith("UNKNOWN KEY 01-synthetic "))).toBe(true);
    // the key name itself is never printed
    expect(errors.join("\n")).not.toContain("zzUnlistedKey");
  });

  it("returns 1 before writing anything when a git lookup is empty", () => {
    const { raw, out } = rawWith([userRow("C:/Users/zed/projects/sessiondeck")]);
    expect(runTranscripts(raw, out, { ownProject: "sessiondeck", git: noGit, host })).toBe(1);
    expect(existsSync(join(out, "transcripts"))).toBe(false);
    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain("git user.email, git user.name, origin owner");
  });

  it("runs with empty git lookups when --no-git-literals is given, and says so", () => {
    const { raw, out } = rawWith([userRow("C:/Users/zed/projects/sessiondeck")]);
    const opts = { ownProject: "sessiondeck", git: noGit, host, noGitLiterals: true };
    expect(runTranscripts(raw, out, opts)).toBe(0);
    expect(existsSync(join(out, "transcripts", "01-synthetic", "session.jsonl"))).toBe(true);
    expect(vi.mocked(console.error).mock.calls.join("\n")).toContain("warning: git lookup empty");
  });

  it("returns 1 when the own project folder is not a usable name", () => {
    const { raw, out } = rawWith([userRow("C:/Users/zed/projects/sessiondeck")]);
    expect(runTranscripts(raw, out, { ownProject: "", git: fullGit, host })).toBe(1);
    expect(runTranscripts(raw, out, { ownProject: "a b/c", git: fullGit, host })).toBe(1);
  });
});

describe("own project is <PROJECT_A>", () => {
  const readOut = (out: string): string =>
    readFileSync(join(out, "01-synthetic", "session.jsonl"), "utf8");
  const literals = { users: [], emails: [], accounts: [], fragments: [], denyWords: [] };
  const rows = [
    userRow("C:/Users/zed/projects/alpha"),
    userRow("C:/Users/zed/projects/sessiondeck"),
  ];

  it("maps the first-sorting other project to A without the own-project seed", () => {
    const { raw, out } = rawWith(rows);
    scrubFixture(join(raw, "transcripts", "01-synthetic"), out, "01-synthetic", literals);
    const lines = readOut(out).split("\n");
    expect(JSON.parse(lines[0] ?? "").cwd).toBe("<HOME>/projects/<PROJECT_A>");
  });

  it("maps the repository's own folder to A when it is seeded first", () => {
    const { raw, out } = rawWith(rows);
    scrubFixture(
      join(raw, "transcripts", "01-synthetic"),
      out,
      "01-synthetic",
      literals,
      "sessiondeck",
    );
    const lines = readOut(out).split("\n");
    expect(JSON.parse(lines[0] ?? "").cwd).toBe("<HOME>/projects/<PROJECT_B>");
    expect(JSON.parse(lines[1] ?? "").cwd).toBe("<HOME>/projects/<PROJECT_A>");
  });

  it("flags a mapper whose A is another project, case-insensitively for the own one", () => {
    const projects = new Map([
      ["alpha", "<PROJECT_A>"],
      ["sessiondeck", "<PROJECT_B>"],
    ]);
    expect(ownProjectProblem(projects, "sessiondeck")).toContain("--own-project");
    expect(ownProjectProblem(new Map([["SessionDeck", "<PROJECT_A>"]]), "sessiondeck")).toBeNull();
    expect(ownProjectProblem(new Map(), "sessiondeck")).toContain("--own-project");
  });

  it("accepts folder names and rejects paths and empty names", () => {
    expect(isProjectName("sessiondeck")).toBe(true);
    expect(isProjectName("my-repo.v2")).toBe(true);
    for (const bad of ["", "a/b", "a b", "..", "-x"]) expect(isProjectName(bad), bad).toBe(false);
  });
});
