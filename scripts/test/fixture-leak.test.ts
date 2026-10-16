import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveLiterals, leakCheck, listFixtureFiles } from "../lib/fixture-leak-core.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";
import { LEAK, SID_A, makeRaw, runNode } from "./fixture-raw-helpers";

afterEach(cleanupTempDirs);

describe("leak check", () => {
  function fixturesWith(files: Record<string, unknown>): string {
    const root = makeTempDir();
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
    }
    return root;
  }

  it("passes clean placeholder-only input", () => {
    const root = fixturesWith({
      "Stop/01.json": {
        hook_event_name: "Stop",
        cwd: "<HOME>/projects/<PROJECT_A>",
        last_assistant_message: "<TEXT 12>",
        error: "rate_limit",
        message: "",
      },
      "sessions/g.jsonl": '{"prompt":"<TEXT 3>"}\n{"prompt":"<TEXT 4>"}\n',
    });
    const r = leakCheck(root);
    expect(r.total).toBe(0);
    expect(r.files).toBe(2);
  });

  it("flags home paths in every slash form", () => {
    for (const p of [
      "C:\\\\Users\\\\bob\\\\x",
      "C:/Users/bob/x",
      "c:\\Users\\bob",
      "/home/bob/x",
      "/Users/bob/x",
      "C--Users-bob-projects",
    ]) {
      const root = fixturesWith({ "Stop/a.json": { cwd: p } });
      expect(leakCheck(root).byCategory["home-path-shape"], p).toBe(1);
    }
  });

  it("flags emails, token prefixes, token runs and long strings, by count not value", () => {
    const root = fixturesWith({
      "Stop/a.json": {
        a: "me@example.org",
        b: "ghp_abcdefghijklmnopqrstuv",
        c: "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5",
        d: "x".repeat(201),
      },
    });
    const r = leakCheck(root);
    expect(r.byCategory["email"]).toBe(1);
    expect(r.byCategory["token-prefix"]).toBe(1);
    expect(r.byCategory["token-run"]).toBeGreaterThanOrEqual(1);
    expect(r.byCategory["string-over-200"]).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r)).not.toContain("me@example.org");
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnopqrstuv");
  });

  it("ignores uuids, toolu ids and the sk- inside ordinary words", () => {
    const root = fixturesWith({
      "Stop/a.json": {
        session_id: SID_A,
        tool_use_id: "toolu_01ABCdefGHIjklMNOpqrstuvwxyz1234",
        task_id: "task001",
      },
    });
    expect(leakCheck(root).total).toBe(0);
  });

  it("does not take a long relative file path in prose for a token run", () => {
    const root = fixturesWith({
      "README.md": "See docs/research/2026-10-08-feasibility-and-oss.md for the note.",
      "other.md": "See docs/research/2026-10-08-feasibility-and-oss for the note.",
    });
    const r = leakCheck(root);
    expect(r.perFile.filter((f) => f.file === "README.md")).toEqual([]);
    expect(r.perFile.find((f) => f.file === "other.md")?.category).toBe("token-run");
  });

  it("flags a non-placeholder value under a free-text key, at depth and in arrays", () => {
    const root = fixturesWith({
      "PostToolUse/a.json": {
        tool_response: { content: "real text" },
        tool_input: { questions: [{ question: "real?" }] },
        reason: "free text with spaces",
      },
    });
    expect(leakCheck(root).byCategory["free-text-not-placeholder"]).toBe(3);
  });

  it("flags unparseable files and ignores raw/ and settings/", () => {
    const root = fixturesWith({
      "Stop/bad.json": "{nope",
      "raw/Stop/a.json": { cwd: "C:/Users/bob" },
      "settings/s.json": { command: "anything" },
    });
    const r = leakCheck(root);
    expect(r.byCategory).toEqual({ "unparseable-json": 1 });
  });

  it("derives the user and project names from raw and flags them in any form", () => {
    const raw = makeRaw();
    const none = { segments: [], names: [] };
    expect(deriveLiterals(raw)).toEqual({ users: ["zed"], projects: ["alpha"], ...none });
    expect(deriveLiterals(null)).toEqual({ users: [], projects: [], ...none });
    const root = fixturesWith({ "Stop/a.json": { x: "folder Alpha here", y: "/data/zed" } });
    const r = leakCheck(root, { rawRoot: raw });
    expect(r.byCategory["project-name"]).toBe(1);
    const users = fixturesWith({ "Stop/a.json": { x: "x/Users/zed/y" } });
    expect(leakCheck(users, { rawRoot: raw }).byCategory["user-name"]).toBe(1);
    expect(leakCheck(users).byCategory["user-name"]).toBeUndefined();
  });

  it("CLI exits 1 on a planted leak, 0 on clean input, and prints no values", () => {
    const dirty = fixturesWith({ "Stop/a.json": { x: "mail me@example.org" } });
    const bad = runNode(LEAK, [dirty, "--raw", join(dirty, "no-raw")]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("FAIL");
    expect(bad.stdout).toContain("patterns only");
    expect(bad.stdout).not.toContain("example.org");
    const clean = fixturesWith({ "Stop/a.json": { prompt: "<TEXT 3>" } });
    expect(runNode(LEAK, [clean, "--raw", join(clean, "no-raw")]).status).toBe(0);
    expect(runNode(LEAK, [join(clean, "missing")]).status).toBe(2);
  });

  it("listFixtureFiles returns every file, sorted, skipping raw at the top only", () => {
    const root = fixturesWith({
      "a/1.json": {},
      "a/2.txt": "x",
      "b/c/3.jsonl": "{}\n",
      "raw/4.json": {},
      "a/raw/5.json": {},
    });
    expect(listFixtureFiles(root).map((f) => f.slice(root.length).split("\\").join("/"))).toEqual([
      "/a/1.json",
      "/a/2.txt",
      "/a/raw/5.json",
      "/b/c/3.jsonl",
    ]);
  });
});
