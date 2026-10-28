// Synthetic input only: every name, path, email and token below is invented for these tests.
// Security gate fix (R0.7): private-config content, configuration blocks, hook output, tool output.
import { describe, expect, it } from "vitest";
import { Mapper } from "../lib/fixture-scrub-paths.mjs";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import {
  attachmentDropKeys,
  countMcpNames,
  isOutsideProject,
  isPrivateToolUse,
  mapMcpPhrase,
} from "../lib/transcript-scrub-private.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

const HOME = "C:/Users/zorbo";
const OWN = `${HOME}/projects/demo`;
const UUID = "11111111-2222-4333-8444-555555555555";

/** A scrubber whose project A is "demo" (the session's own project). */
function scrubber(): TranscriptScrubber {
  const mapper = new Mapper();
  mapper.seedProjects([OWN]);
  return new TranscriptScrubber({ mapper, literals: { users: ["zorbo"] } });
}
const att = (attachment: Record<string, unknown>): Out => ({ type: "attachment", attachment });

describe("private config content next to a path outside the project", () => {
  it("drops nested_memory and instructions content under the user-level Claude folder", () => {
    const out = scrubber().row(
      att({
        type: "nested_memory",
        path: `${HOME}/.claude/CLAUDE.md`,
        content: { path: `${HOME}/.claude/CLAUDE.md`, type: "User", content: "a private heading" },
      }),
    ) as Out;
    expect(out.attachment.content).toMatch(/^<BLOB \d+>$/);
    expect(JSON.stringify(out)).not.toContain("private heading");
    expect(out.attachment.path).toMatch(/^<HOME>\/\.claude\/<FILE_\d+>\.md$/);
  });

  it("drops edited_text_file snippets and instructions file lists outside the project", () => {
    const out = scrubber().row(
      att({
        type: "edited_text_file",
        filename: `${HOME}/.claude/rules/x.md`,
        snippet: "a private heading\nmore",
      }),
    ) as Out;
    expect(out.attachment.snippet).toMatch(/^<BLOB \d+>$/);
    const list = scrubber().row(
      att({
        type: "instructions",
        files: [{ path: `${HOME}/.claude/CLAUDE.md`, type: "User", content: "private words" }],
      }),
    ) as Out;
    expect(list.attachment.files[0].content).toMatch(/^<BLOB \d+>$/);
  });

  it("drops contents next to a path in another repo or a temp folder, keeps the project's own", () => {
    const s = scrubber();
    const other = s.row(
      att({ type: "file", filename: `${HOME}/projects/other/a.ts`, content: "other repo text" }),
    ) as Out;
    const temp = s.row(
      att({ type: "file", filename: "C:/Windows/Temp/a.ts", content: "temp text" }),
    ) as Out;
    const own = s.row(
      att({ type: "file", filename: `${OWN}/a.ts`, content: "own project text" }),
    ) as Out;
    expect(other.attachment.content).toMatch(/^<BLOB/);
    expect(temp.attachment.content).toMatch(/^<BLOB/);
    expect(own.attachment.content).toBe("own project text");
  });

  it("drops a search pattern and diff hunks next to a private path", () => {
    const out = scrubber().row({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_0001abcd",
            name: "Grep",
            input: { pattern: "private term", path: `${HOME}/.claude` },
          },
        ],
      },
    }) as Out;
    expect(out.message.content[0].input.pattern).toMatch(/^<BLOB/);
  });

  it("isOutsideProject separates the own project, relative paths and everything else", () => {
    expect(isOutsideProject("<HOME>/.claude/CLAUDE.md")).toBe(true);
    expect(isOutsideProject("<HOME>/projects/<PROJECT_B>/a.ts")).toBe(true);
    expect(isOutsideProject("<ROOT>/tmp/x")).toBe(true);
    expect(isOutsideProject("~/.claude/x.md")).toBe(true);
    expect(isOutsideProject("<HOME>/projects/<PROJECT_A>/a.ts")).toBe(false);
    expect(isOutsideProject("src/a.ts")).toBe(false);
  });
});

describe("configuration blocks and hook output", () => {
  it("drops addedBlocks, addedLines and the content of a skill listing", () => {
    const s = scrubber();
    const mcp = s.row(
      att({
        type: "mcp_instructions_delta",
        addedNames: ["srv"],
        addedBlocks: ["## srv\nprivate"],
      }),
    ) as Out;
    const agents = s.row(
      att({ type: "agent_listing_delta", addedTypes: ["Explore"], addedLines: ["- x: desc"] }),
    ) as Out;
    const skills = s.row(
      att({ type: "skill_listing", content: "- skill: desc", names: ["a"] }),
    ) as Out;
    expect(mcp.attachment.addedBlocks).toMatch(/^<BLOB \d+>$/);
    expect(agents.attachment.addedLines).toMatch(/^<BLOB \d+>$/);
    expect(skills.attachment.content).toMatch(/^<BLOB \d+>$/);
  });

  it("drops hook_additional_context content and hook stdout", () => {
    const s = scrubber();
    const ctx = s.row(
      att({ type: "hook_additional_context", hookEvent: "SessionStart", content: ["memory text"] }),
    ) as Out;
    const ok = s.row(
      att({
        type: "hook_success",
        hookEvent: "UserPromptSubmit",
        stdout: '{"memory":"text"}',
        content: "text",
        exitCode: 0,
      }),
    ) as Out;
    expect(ctx.attachment.content).toMatch(/^<BLOB \d+>$/);
    expect(ok.attachment.stdout).toMatch(/^<BLOB \d+>$/);
    expect(ok.attachment.content).toMatch(/^<BLOB \d+>$/);
    expect(ok.attachment.exitCode).toBe(0);
  });

  it("attachmentDropKeys is empty for ordinary attachments", () => {
    expect(attachmentDropKeys({ type: "file" }).size).toBe(0);
    expect(attachmentDropKeys({ type: "skill_listing" }).has("content")).toBe(true);
    expect(attachmentDropKeys({ hookEvent: "Stop" }).has("stdout")).toBe(true);
  });
});

describe("tool output of a tool that touched something private", () => {
  const use = (name: string, input: Record<string, unknown>, id: string): Out => ({
    type: "assistant",
    uuid: UUID,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
  const result = (id: string, text: string): Out => ({
    type: "user",
    uuid: UUID,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    toolUseResult: { stdout: text, stderr: "" },
  });

  it("drops the result block and toolUseResult of a Read outside the project", () => {
    const s = scrubber();
    const rows = [
      use("Read", { file_path: `${HOME}/.claude/CLAUDE.md` }, "toolu_0001aaaa"),
      result("toolu_0001aaaa", "private file text"),
      use("Read", { file_path: `${OWN}/a.ts` }, "toolu_0002bbbb"),
      result("toolu_0002bbbb", "own file text"),
    ];
    s.prime(rows);
    const out = rows.map((r) => s.row(r) as Out);
    expect(out[1]?.message.content[0].content).toMatch(/^<BLOB \d+>$/);
    expect(out[1]?.toolUseResult).toMatch(/^<BLOB \d+>$/);
    expect(out[3]?.message.content[0].content).toBe("own file text");
    expect(out[3]?.toolUseResult.stdout).toBe("own file text");
  });

  it("drops the output of a shell command naming the user-level folder", () => {
    const s = scrubber();
    const rows = [
      use("Bash", { command: `cat ${HOME}/.claude/CLAUDE.md | head` }, "toolu_0003cccc"),
      result("toolu_0003cccc", "private lines"),
      use("Bash", { command: "ls src" }, "toolu_0004dddd"),
      result("toolu_0004dddd", "a.ts"),
    ];
    s.prime(rows);
    const out = rows.map((r) => s.row(r) as Out);
    expect(out[1]?.message.content[0].content).toMatch(/^<BLOB/);
    expect(out[3]?.message.content[0].content).toBe("a.ts");
  });

  it("isPrivateToolUse reads scrubbed paths and commands", () => {
    expect(isPrivateToolUse("Read", { file_path: "<HOME>/.claude/x.md" })).toBe(true);
    expect(isPrivateToolUse("Read", { file_path: "<HOME>/projects/<PROJECT_A>/x.md" })).toBe(false);
    expect(isPrivateToolUse("Bash", { command: "gh api repos/o/r" })).toBe(true);
    expect(isPrivateToolUse("Bash", { command: "cd <HOME>/projects/<PROJECT_A> && ls" })).toBe(
      false,
    );
    expect(
      isPrivateToolUse("Bash", { command: "cd <HOME>/projects/<PROJECT_A><TRUNCATED 99>" }),
    ).toBe(false);
    expect(isPrivateToolUse("Bash", { command: "cd <HOME>/pro<TRUNCATED 99>" })).toBe(false);
    expect(isPrivateToolUse("WebFetch", { url: "x" })).toBe(false);
  });
});

describe("MCP server names in free text", () => {
  it("maps the name after 'MCP server' and leaves prose alone", () => {
    const names: string[] = [];
    const map = (n: string) => {
      names.push(n);
      return "<MCP_1>";
    };
    expect(mapMcpPhrase("The MCP server foo-bar failed", map)).toBe(
      "The MCP server <MCP_1> failed",
    );
    expect(mapMcpPhrase("MCP server is down", map)).toBe("MCP server is down");
    expect(names).toEqual(["foo-bar"]);
    expect(countMcpNames("MCP server foo-bar")).toBe(1);
    expect(countMcpNames("MCP server <MCP_1> and MCP server is down")).toBe(0);
  });
});
