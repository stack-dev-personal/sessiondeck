import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leakCheck } from "../lib/fixture-leak-core.mjs";
import { docAllowFor } from "../lib/fixture-synthetic-doc.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";
import { HOME, SID_A, makeRaw } from "./fixture-raw-helpers";

// Gate findings from the round 2 security and code review (R0.7, conductor decisions 3 and 7).
afterEach(cleanupTempDirs);

function fixturesWith(files: Record<string, unknown>): string {
  const root = makeTempDir();
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

const categories = (files: Record<string, unknown>, rawRoot?: string) =>
  leakCheck(fixturesWith(files), rawRoot ? { rawRoot } : {}).byCategory;

function rawWith(extra: Record<string, unknown>): string {
  const raw = makeRaw();
  writeFileSync(
    join(raw, "SessionStart", "5000-11111111-extra.json"),
    JSON.stringify({ session_id: SID_A, hook_event_name: "SessionStart", ...extra }),
  );
  return raw;
}

describe("home path with a non-ASCII user name", () => {
  it.each([
    ["backslash", "C:\\Users\\\u00c9mile\\x"],
    ["forward slash", "C:/Users/\u00d6zlem/x"],
    ["posix", "/home/\u00e9lodie/x"],
    ["encoded folder", "C--Users-\u00c9mile-projects"],
  ])("flags %s in .md and settings/ files", (_name, value) => {
    expect(categories({ "notes.md": `see ${value}` })["home-path-shape"]).toBe(1);
    expect(categories({ "settings/s.json": { command: `node ${value}` } })["home-path-shape"]).toBe(
      1,
    );
  });
});

describe("path segments below the project folder are literals", () => {
  function rawDeep(): string {
    return rawWith({
      cwd: `${HOME}\\projects\\alpha`,
      tool_input: { file_path: "D:\\clientwork\\Acme-Portal\\src\\billing.ts" },
      tool_name: "Read",
    });
  }

  it("flags a deep client folder in a hand-written .md, bare or next to a separator", () => {
    const raw = rawDeep();
    expect(categories({ "README.md": "We built it for Acme-Portal last year." }, raw)).toEqual({
      "project-name": 1,
    });
    expect(categories({ "README.md": "see <ROOT>/acme-portal/x" }, raw)["project-name"]).toBe(2);
    expect(categories({ "README.md": "file billing.ts" }, raw)["project-name"]).toBeGreaterThan(0);
  });

  it("flags it next to a separator in a payload, but not as an unrelated bare word", () => {
    const raw = rawDeep();
    expect(categories({ "Stop/a.json": { cwd: "<ROOT>/Acme-Portal" } }, raw)["project-name"]).toBe(
      1,
    );
    expect(categories({ "Stop/a.json": { summary: "<TEXT 4>" } }, raw)).toEqual({});
  });

  it("does not flag layout words such as src, or short lowercase words", () => {
    const raw = rawDeep();
    expect(categories({ "README.md": "the src folder, plus the work folder" }, raw)).toEqual({});
  });

  it("treats id-key values that mapId refuses as literals", () => {
    const raw = rawWith({ agent_id: "acmesecretagent" });
    expect(categories({ "README.md": "agent acmesecretagent ran" }, raw)["project-name"]).toBe(1);
  });

  it("searches hand-written files for the bare user name", () => {
    const raw = rawDeep();
    expect(
      categories({ "README.md": "written by zed", "settings/s.json": { a: "zed" } }, raw),
    ).toEqual({ "user-name": 2 });
    expect(categories({ "Stop/a.json": { summary: "<TEXT 3>" } }, raw)).toEqual({});
  });
});

describe("every file type is scanned", () => {
  it("reports a non-json/md file as unscanned-file and still runs the text checks on it", () => {
    const r = categories({
      "notes/a.txt": "C:\\Users\\bob\\x and ghp_abcdefghijklmnopqrstu",
      "notes/b.log": "nothing here",
    });
    expect(r["unscanned-file"]).toBe(2);
    expect(r["home-path-shape"]).toBe(1);
    expect(r["token-prefix"]).toBe(1);
  });

  it("does not report .json, .jsonl or .md files as unscanned", () => {
    const r = categories({
      "Stop/a.json": { summary: "<TEXT 3>" },
      "sessions/g.jsonl": '{"summary":"<TEXT 3>"}\n',
      "README.md": "plain",
    });
    expect(r).toEqual({});
  });
});

describe("id keys accept only the scrubber's id shapes", () => {
  it.each([
    ["letters only", "acmesecretproject"],
    ["hyphenated", "task-synthetic-1"],
    ["underscored", "task_synthetic_1"],
    ["too short", "ab1"],
  ])("flags %s", (_name, value) => {
    expect(categories({ "Stop/a.json": { session_id: value } })["string-not-allowlisted"]).toBe(1);
  });

  it.each([
    ["alnum with a digit", "IuTvwWJM3"],
    ["digit in the middle", "cf0IBpTBB"],
    ["hex", "deadbeef"],
    ["uuid", SID_A],
    ["toolu id", "toolu_01ABCdefGHIjklMNOpqr12"],
  ])("accepts %s", (_name, value) => {
    expect(categories({ "Stop/a.json": { session_id: value } })).toEqual({});
  });
});

describe("documentation example strings in synthetic/ only", () => {
  const failure = {
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
    last_assistant_message: "API Error: Rate limit reached",
  };
  const denied = {
    hook_event_name: "PermissionDenied",
    reason: "[Irreversible Local Destruction]",
  };

  it("accepts them at the listed file and key path", () => {
    expect(
      categories({
        "synthetic/StopFailure/01-synthetic.json": failure,
        "synthetic/PermissionDenied/01-synthetic.json": denied,
      }),
    ).toEqual({});
  });

  it("rejects the same strings in a captured directory or another synthetic file", () => {
    const r = categories({
      "StopFailure/01.json": failure,
      "PermissionDenied/01.json": denied,
      "synthetic/StopFailure/02-other.json": failure,
    });
    expect(r["free-text-not-placeholder"]).toBe(5);
  });

  it("is an exact-string match: a near variant is still a finding", () => {
    const r = categories({
      "synthetic/StopFailure/01-synthetic.json": {
        ...failure,
        error_details: "429 Too Many Requests!",
      },
      "synthetic/PermissionDenied/01-synthetic.json": {
        ...denied,
        reason: "[Irreversible Local Destruction] and more",
      },
    });
    expect(r["free-text-not-placeholder"]).toBe(2);
  });

  it("lists the doc URL as the reason for each allowance, and nothing for other files", () => {
    expect(docAllowFor("synthetic/StopFailure/01-synthetic.json")).toEqual({
      error_details: "429 Too Many Requests",
      last_assistant_message: "API Error: Rate limit reached",
    });
    expect(docAllowFor("Stop/a.json")).toEqual({});
    expect(docAllowFor("constructor")).toEqual({});
  });
});
