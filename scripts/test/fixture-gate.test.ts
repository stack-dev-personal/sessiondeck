import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveLiterals, leakCheck } from "../lib/fixture-leak-core.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";
import { FIXTURES_ROOT } from "../lib/fixture-files.mjs";
import { HOME, makeRaw } from "./fixture-raw-helpers";

// The leak gate as an independent check (R0.7): structure, key names, home-path forms and literals.
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

describe("home path forms", () => {
  it.each([
    ["MSYS", "/c/Users/bob/projects/x"],
    ["MSYS lowercase folder", "/c/users/bob/x"],
    ["WSL", "/mnt/c/Users/bob/x"],
    ["lowercase drive and folder", "c:/users/bob/x"],
    ["lowercase with backslashes", "c:\\users\\bob\\x"],
    ["lowercase folder in a command", "cd /c/users/bob && ls"],
    ["encoded folder, lowercase", "c--users-bob-projects"],
  ])("flags %s in a payload and in prose", (_name, value) => {
    expect(categories({ "Stop/a.json": { cwd: value } })["home-path-shape"], value).toBe(1);
    expect(categories({ "notes.md": `See ${value} for details.` })["home-path-shape"]).toBe(1);
  });

  it("does not flag placeholder homes or the words users/home in prose", () => {
    const r = categories({
      "Stop/a.json": { cwd: "<HOME>/projects/<PROJECT_A>" },
      "notes.md": "Many users work at home. Use /users/<id> routes.",
    });
    expect(r["home-path-shape"]).toBeUndefined();
  });

  it("scans settings/ and .md files with the text checks", () => {
    const r = categories({
      "settings/s.json": { command: "node C:\\Users\\bob\\x.js" },
      "README.md": "mail me@example.org",
    });
    expect(r["home-path-shape"]).toBe(1);
    expect(r["email"]).toBe(1);
  });

  it("does not apply the payload structure check to settings/", () => {
    expect(categories({ "settings/s.json": { command: "anything", whatever: "text" } })).toEqual(
      {},
    );
  });
});

describe("key names are default-deny", () => {
  it("flags a key that is not in the known-key list, nested and in arrays", () => {
    const r = categories({
      "Stop/a.json": { workspace: { repos: { "my-private-repo": { name: "<TEXT 4>" } } } },
      "Stop/b.json": { tasks: [{ id: "abcdef12", "secret-key": "<TEXT 3>" }] },
    });
    expect(r["unknown-key"]).toBe(3);
  });

  it("accepts known keys and <TEXT n> keys under user-keyed objects", () => {
    const r = categories({
      "Stop/a.json": {
        hook_event_name: "Stop",
        answers: { "<TEXT 12>": "<TEXT 3>", "<TEXT 12>#2": "<TEXT 3>" },
      },
    });
    expect(r).toEqual({});
  });

  it("flags a <KEY_n> key anywhere: the scrub's exit 1 review must happen before commit", () => {
    const r = categories({
      "Stop/a.json": { tool_input: { "<KEY_1>": "<TEXT 5>" } },
      "Stop/b.json": { "<KEY_2>": 4815162342 },
      "Stop/c.json": { answers: { "<KEY_1>": "<TEXT 3>" } },
    });
    expect(r["unknown-key"]).toBe(3);
  });

  it("flags a <TEXT n> key outside user-keyed objects", () => {
    expect(categories({ "Stop/a.json": { tool_input: { "<TEXT 9>": "<TEXT 3>" } } })).toEqual({
      "unknown-key": 1,
    });
  });

  it("flags readable key names under user-keyed objects", () => {
    expect(
      categories({ "Stop/a.json": { answers: { "which db?": "<TEXT 3>" } } })["unknown-key"],
    ).toBe(1);
  });
});

describe("string values are default-deny without raw/", () => {
  it.each([
    ["workspace.repo.name", { workspace: { repo: { name: "my-private-repo" } } }],
    ["gitOperation.push.branch", { gitOperation: { push: { branch: "feat/secret" } } }],
    ["tool_input.skill", { tool_input: { skill: "private-skill" } }],
    ["name", { name: "private" }],
    ["title", { title: "Private title" }],
    ["url", { url: "https://example.org/private" }],
    ["session_name", { session_name: "my session" }],
  ])("flags a raw string under %s", (_name, payload) => {
    const r = categories({ "Stop/a.json": payload });
    expect((r["string-not-allowlisted"] ?? 0) + (r["free-text-not-placeholder"] ?? 0)).toBe(1);
  });

  it("accepts the placeholders the scrubber emits", () => {
    const r = categories({
      "PreToolUse/a.json": {
        tool_name: "mcp__<MCP_1>__<TOOL_2>",
        tool_use_id: "toolu_01ABCdefGHIjklMNOpqr12",
        agent_type: "<AGENT_1>",
        cwd: "<HOME>/projects/<PROJECT_A>/<DIR_1>",
        transcript_path:
          "<HOME>/.claude/projects/<PROJECT_B>/11111111-2222-4333-8444-555555555555.jsonl",
        tool_input: { file_path: "<ROOT>/<DIR_2>/<FILE_3>.ts", command: "<TEXT 9>" },
        mcp_server: { name: "<MCP_1>" },
        output_style: { name: "default" },
      },
    });
    expect(r).toEqual({});
  });

  it("flags a path key whose value is not a path placeholder, including trailing text", () => {
    const r = categories({
      "Stop/a.json": { cwd: "<HOME>/x real command text" },
      "Stop/b.json": { cwd: "<HOME>/projects/<PROJECT_A>/secret-dir" },
      "Stop/c.json": { cwd: "relative/dir" },
      "Stop/d.json": { command: "<HOME>/x real command text" },
    });
    expect(r["string-not-allowlisted"]).toBe(3);
    expect(r["free-text-not-placeholder"]).toBe(1);
  });

  it("flags a real tool, mcp server, agent or id under their keys", () => {
    const r = categories({
      "Stop/a.json": {
        tool_name: "mcp__realserver__realtool",
        mcp_server: { name: "realserver" },
        agent_type: "my-custom-agent",
        session_id: "not an id!",
      },
    });
    expect(r["string-not-allowlisted"]).toBe(4);
  });

  it("applies the tool_response enum rules to built-in tools only", () => {
    const builtin = categories({
      "PostToolUse/a.json": { tool_name: "Bash", tool_response: { status: "async_launched" } },
    });
    const custom = categories({
      "PostToolUse/b.json": {
        tool_name: "mcp__<MCP_1>__<TOOL_1>",
        tool_response: { status: "private-project-slug" },
      },
    });
    expect(builtin).toEqual({});
    expect(custom["string-not-allowlisted"]).toBe(1);
  });

  it("keeps only the built-in output style names", () => {
    expect(categories({ "Stop/a.json": { output_style: { name: "Learning" } } })).toEqual({});
    expect(
      categories({ "Stop/b.json": { output_style: { name: "My Private Style" } } })[
        "string-not-allowlisted"
      ],
    ).toBe(1);
  });

  it("flags numbers under id and account keys unless zeroed", () => {
    const r = categories({
      "Stop/a.json": { org_id: 4242, user_id: 7, tabId: 99, account: { number: 5 } },
      "Stop/b.json": { org_id: 0, tabId: 0, duration_ms: 1234 },
    });
    expect(r["id-number"]).toBe(3);
  });
});

describe("literals derived from raw/", () => {
  function rawWithExtras(): string {
    const raw = makeRaw();
    const dir = join(raw, "SessionStart");
    writeFileSync(
      join(dir, "5000-11111111-extra.json"),
      JSON.stringify({
        session_id: "11111111-2222-4333-8444-555555555555",
        cwd: `${HOME}\\projects\\alpha`,
        hook_event_name: "SessionStart",
        session_name: "Zebrafish Migration",
        workspace: {
          added_dirs: [`${HOME}\\projects\\hiddenproj`],
          repo: { name: "crypticrepo", owner: "acmeowner" },
        },
        gitOperation: { push: { branch: "feat/mangrove" } },
        tool_name: "mcp__bluegill__quokka",
      }),
    );
    return raw;
  }

  it("derives projects from every path value, and names from named fields", () => {
    const lit = deriveLiterals(rawWithExtras());
    expect(lit.projects).toEqual(["alpha", "hiddenproj"]);
    expect(lit.names).toEqual(
      expect.arrayContaining([
        "Zebrafish Migration",
        "crypticrepo",
        "acmeowner",
        "bluegill",
        "quokka",
      ]),
    );
    expect(lit.names).not.toContain("main");
  });

  it("flags those literals in values and in key names, in any case, with raw present", () => {
    const raw = rawWithExtras();
    const r = categories(
      {
        "Stop/a.json": { note: "<TEXT 3>", HiddenProj: "<TEXT 3>" },
        "Stop/b.json": { summary: "went to ZEBRAFISH migration today" },
        "Stop/c.json": { cwd: "<HOME>/projects/Crypticrepo" },
        "Stop/d.json": { tool_name: "mcp__bluegill__quokka" },
      },
      raw,
    );
    expect(r["project-name"]).toBe(5); // one per matching literal per file; d.json matches two
  });

  it("reports nothing for the same literals when they are placeholders", () => {
    const r = categories(
      { "Stop/a.json": { cwd: "<HOME>/projects/<PROJECT_B>", session_name: "<TEXT 19>" } },
      rawWithExtras(),
    );
    expect(r["project-name"]).toBeUndefined();
  });

  it("does not let a literal equal to a schema key word flag every payload", () => {
    const raw = makeRaw();
    writeFileSync(
      join(raw, "SessionStart", "5001-11111111-extra.json"),
      JSON.stringify({
        session_id: "11111111-2222-4333-8444-555555555555",
        session_name: "Workspace",
      }),
    );
    expect(categories({ "Stop/a.json": { workspace: { current_dir: "<HOME>" } } }, raw)).toEqual(
      {},
    );
  });
});

describe("committed fixture set", () => {
  it("passes the gate without raw/ (what CI runs), with every payload scanned", () => {
    const r = leakCheck(FIXTURES_ROOT);
    expect(r.byCategory).toEqual({});
    expect(r.files).toBeGreaterThan(100);
  });
});
