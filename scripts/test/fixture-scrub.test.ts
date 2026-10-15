import { describe, expect, it } from "vitest";
import { Scrubber, isToken } from "../lib/fixture-scrub-core.mjs";
import { Mapper, encodePath, mapId } from "../lib/fixture-scrub-paths.mjs";
import { BUILTIN_TOOLS } from "../lib/fixture-allowlist.mjs";

// Scrubbed output is arbitrary JSON; tests index into it by path, so one loose alias is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

const SID = "0e3409ab-a8e4-4bef-9d20-4e7da6f8cb46";

describe("Mapper.mapPath", () => {
  it("maps both slash forms and both drive-letter cases to the same placeholder", () => {
    const m = new Mapper();
    const forms = [
      "C:\\Users\\alice\\projects\\demo\\src\\app.ts",
      "c:\\Users\\alice\\projects\\demo\\src\\app.ts",
      "C:/Users/alice/projects/demo/src/app.ts",
      "c:/Users/alice/projects/demo/src/app.ts",
      "/c/Users/alice/projects/demo/src/app.ts",
    ];
    const outs = forms.map((f) => m.mapPath(f, "file"));
    expect(new Set(outs).size).toBe(1);
    expect(outs[0]).toBe("<HOME>/projects/<PROJECT_A>/<DIR_1>/<FILE_1>.ts");
  });

  it("maps posix homes and tilde", () => {
    const m = new Mapper();
    expect(m.mapPath("/home/bob/projects/demo", "dir")).toBe("<HOME>/projects/<PROJECT_A>");
    expect(m.mapPath("/Users/bob/projects/other/x", "dir")).toBe(
      "<HOME>/projects/<PROJECT_B>/<DIR_1>",
    );
    expect(m.mapPath("~/.claude", "dir")).toBe("<HOME>/.claude");
  });

  it("gives projects letters in sorted seed order, not first-use order", () => {
    const m = new Mapper();
    m.seedProjects(["C:\\Users\\a\\projects\\zeta", "C:\\Users\\a\\projects\\alpha"]);
    expect(m.mapPath("C:/Users/a/projects/zeta", "dir")).toBe("<HOME>/projects/<PROJECT_B>");
    expect(m.mapPath("C:/Users/a/projects/alpha", "dir")).toBe("<HOME>/projects/<PROJECT_A>");
  });

  it("maps the encoded project folder to the same project as its cwd", () => {
    const m = new Mapper();
    m.seedProjects(["C:\\Users\\alice\\projects\\my-app"]);
    const cwd = m.mapPath("C:\\Users\\alice\\projects\\my-app", "dir");
    const transcript = m.mapPath(
      `C:\\Users\\alice\\.claude\\projects\\${encodePath("C:\\Users\\alice\\projects\\my-app")}\\${SID}.jsonl`,
      "file",
    );
    expect(cwd).toBe("<HOME>/projects/<PROJECT_A>");
    expect(transcript).toBe(`<HOME>/.claude/projects/<PROJECT_A>/${mapId(SID)}.jsonl`);
  });

  it("matches an encoded worktree folder to its parent project by prefix", () => {
    const m = new Mapper();
    m.seedProjects(["C:\\Users\\alice\\projects\\wt"]);
    const enc = encodePath("C:\\Users\\alice\\projects\\wt\\S1");
    expect(m.mapPath(`C:/Users/alice/.claude/projects/${enc}/x.jsonl`, "file")).toBe(
      "<HOME>/.claude/projects/<PROJECT_A>/<FILE_1>.jsonl",
    );
  });

  it("keeps structural directories, maps ids inside paths, and non-home roots become <ROOT>", () => {
    const m = new Mapper();
    const p = m.mapPath(`C:/Users/a/AppData/Local/Temp/claude/${SID}/scratchpad`, "dir");
    expect(p).toBe(`<HOME>/AppData/Local/Temp/claude/${mapId(SID)}/scratchpad`);
    expect(m.mapPath("D:\\data\\notes.txt", "file")).toBe("<ROOT>/<DIR_1>/<FILE_1>.txt");
    expect(m.mapPath("/tmp/work", "dir")).toBe("<ROOT>/tmp/<DIR_2>");
  });

  it("maps agent transcript names and relative paths", () => {
    const m = new Mapper();
    const out = m.mapPath(`C:/Users/a/projects/p/subagents/agent-0123456789abcdef0.jsonl`, "file");
    expect(out).toBe(
      "<HOME>/projects/<PROJECT_A>/subagents/agent-" + mapId("0123456789abcdef0") + ".jsonl",
    );
    expect(m.mapPath("src/lib/util.test.ts", "auto")).toBe("<DIR_1>/<DIR_2>/<FILE_1>.ts");
    expect(m.mapPath("../up/file", "auto")).toBe("../<DIR_3>/<DIR_4>");
  });

  it("returns null for strings that are not path-shaped or are too long", () => {
    const m = new Mapper();
    expect(m.mapPath("hello world", "dir")).toBeNull();
    expect(m.mapPath("C:/" + "a/".repeat(300), "dir")).toBeNull();
  });

  it("keeps a file extension only for files", () => {
    const m = new Mapper();
    expect(m.mapPath("/home/u/projects/p/v1.2", "dir")).toBe("<HOME>/projects/<PROJECT_A>/<DIR_1>");
    expect(m.mapPath("/home/u/projects/p/v1.2/a.b.json", "file")).toBe(
      "<HOME>/projects/<PROJECT_A>/<DIR_1>/<FILE_1>.json",
    );
  });
});

describe("Mapper names", () => {
  it("keeps built-in tools, maps mcp tools and unknown tools consistently", () => {
    const m = new Mapper();
    expect(m.mapTool("Bash", BUILTIN_TOOLS)).toBe("Bash");
    const a = m.mapTool("mcp__secretserver__do_thing", BUILTIN_TOOLS);
    expect(a).toBe("mcp__<MCP_1>__<TOOL_1>");
    expect(m.mapTool("mcp__secretserver__other", BUILTIN_TOOLS)).toBe("mcp__<MCP_1>__<TOOL_2>");
    expect(m.mapMcp("secretserver")).toBe("<MCP_1>");
    expect(m.mapTool("CustomThing", BUILTIN_TOOLS)).toBe("<TOOL_3>");
  });

  it("keeps built-in and empty agent types, maps custom ones", () => {
    const m = new Mapper();
    const builtin = new Set(["general-purpose"]);
    expect(m.mapAgent("general-purpose", builtin)).toBe("general-purpose");
    expect(m.mapAgent("", builtin)).toBe("");
    expect(m.mapAgent("my-private-agent", builtin)).toBe("<AGENT_1>");
    expect(m.mapAgent("my-private-agent", builtin)).toBe("<AGENT_1>");
  });
});

describe("mapId", () => {
  it("is deterministic, shape-preserving and not the identity", () => {
    const out = mapId(SID);
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(out).not.toBe(SID);
    expect(mapId(SID.toUpperCase())).toBe(out);
    const toolu = mapId("toolu_01ABCdefGHIjklMNOpqr12");
    expect(toolu).toMatch(/^toolu_[A-Za-z0-9]{22}$/);
    expect(mapId("0123456789abcdef0")).toMatch(/^[0-9a-f]{17}$/);
    expect(mapId("dpEeKb1Yt")).toMatch(/^[A-Za-z0-9]{9}$/);
  });

  it("returns null for values with no id shape", () => {
    expect(mapId("not an id")).toBeNull();
    expect(mapId("abc")).toBeNull();
  });
});

describe("isToken", () => {
  it.each([
    "sk-ant-api03-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwx",
    "gho_abcdefghijklmnopqrstuvwx",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234-abcdef",
    "Bearer abc.def.ghi",
    "0123456789abcdef0123456789abcdef",
    "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5",
  ])("flags %s-shaped values", (v) => {
    expect(isToken(v)).toBe(true);
  });

  it("does not flag ordinary words or short ids", () => {
    expect(isToken("general-purpose")).toBe(false);
    expect(isToken("abcdefabcdefabcdefabcdefabcdefab-")).toBe(false);
    expect(isToken("hello")).toBe(false);
  });
});

describe("Scrubber", () => {
  it("keeps allowlisted structural strings, numbers, booleans and null verbatim", () => {
    const s = new Scrubber();
    const input = {
      hook_event_name: "Stop",
      permission_mode: "auto",
      stop_hook_active: false,
      duration_ms: 12.5,
      result: null,
      model: { id: "claude-test-1", display_name: "Test 1" },
      effort: { level: "high" },
      version: "2.1.301",
      trigger: "manual",
      tool_name: "Bash",
    };
    expect(s.value(input)).toEqual(input);
  });

  it("replaces free text with <TEXT n> keeping the original length, and keeps empty strings", () => {
    const s = new Scrubber();
    const out = s.value({
      prompt: "please fix the secret thing",
      last_assistant_message: "x".repeat(5000),
      message: "",
    }) as Record<string, string>;
    expect(out["prompt"]).toBe("<TEXT 27>");
    expect(out["last_assistant_message"]).toBe("<TEXT 5000>");
    expect(out["message"]).toBe("");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("denies allowlisted keys whose value fails the pattern", () => {
    const s = new Scrubber();
    expect(s.value({ trigger: "some free text here" })).toEqual({ trigger: "<TEXT 19>" });
    expect(s.value({ source: "/home/x/secret" })).toEqual({ source: "<TEXT 14>" });
  });

  it("redacts whole-value tokens, emails and account-like keys, in that order", () => {
    const s = new Scrubber();
    const out = s.value({
      summary: "ghp_abcdefghijklmnopqrstuvwxyz0123",
      label: "someone@example.com",
      workspace: { repo: { owner: "acme-corp", name: "private-repo", host: "github.com" } },
    }) as Out;
    expect(out.summary).toBe("<REDACTED>");
    expect(out.label).toBe("<EMAIL>");
    expect(out.workspace.repo.owner).toBe("<ACCOUNT>");
    expect(out.workspace.repo.name).toBe("<TEXT 12>");
    expect(out.workspace.repo.host).toBe("github.com");
  });

  it("hides tokens and emails embedded in longer text", () => {
    const s = new Scrubber();
    const out = JSON.stringify(
      s.value({ tool_input: { command: "curl -H 'Authorization: Bearer abc123def456' me@x.org" } }),
    );
    expect(out).toBe('{"tool_input":{"command":"<TEXT 53>"}}');
  });

  it("scrubs nested tool_input and tool_response but keeps their shape", () => {
    const s = new Scrubber();
    const out = s.value({
      tool_name: "Read",
      tool_input: { file_path: "C:\\Users\\alice\\projects\\demo\\README.md", limit: 10 },
      tool_response: {
        type: "text",
        file: {
          filePath: "C:/Users/alice/projects/demo/README.md",
          content: "secret body",
          numLines: 3,
        },
        structuredPatch: [{ oldStart: 1, lines: ["+secret", "-other"] }],
      },
    }) as Out;
    expect(out.tool_input.file_path).toBe("<HOME>/projects/<PROJECT_A>/<FILE_1>.md");
    expect(out.tool_input.limit).toBe(10);
    expect(out.tool_response.file.filePath).toBe(out.tool_input.file_path);
    expect(out.tool_response.file.content).toBe("<TEXT 11>");
    expect(out.tool_response.file.numLines).toBe(3);
    expect(out.tool_response.structuredPatch).toEqual([
      { oldStart: 1, lines: ["<TEXT 7>", "<TEXT 6>"] },
    ]);
    expect(out.tool_response.type).toBe("text");
  });

  it("handles a string tool_response and an array tool_response", () => {
    const s = new Scrubber();
    expect(s.value({ tool_response: "plain output" })).toEqual({ tool_response: "<TEXT 12>" });
    expect(s.value({ tool_response: [{ type: "text", text: "hello" }] })).toEqual({
      tool_response: [{ type: "text", text: "<TEXT 5>" }],
    });
  });

  it("masks key names that are user content and keys under answers", () => {
    const s = new Scrubber();
    const out = s.value({
      tool_input: {
        answers: { "Which database?": "postgres", Pick: "a" },
        "a b": 1,
        __proto__x: 2,
      },
    }) as Out;
    const keys = Object.keys(out.tool_input.answers);
    expect(keys).toEqual(["<TEXT 15>", "<TEXT 4>"]);
    expect(Object.values(out.tool_input.answers)).toEqual(["<TEXT 8>", "<TEXT 1>"]);
    expect(Object.keys(out.tool_input)).toContain("<TEXT 3>");
  });

  it("keeps colliding masked keys apart", () => {
    const s = new Scrubber();
    const out = s.value({ answers: { aaaa: 1, bbbb: 2 } }) as Out;
    expect(Object.keys(out.answers)).toEqual(["<TEXT 4>", "<TEXT 4>#2"]);
  });

  it("neutralises a __proto__ key", () => {
    const s = new Scrubber();
    const out = s.value(JSON.parse('{"__proto__": {"polluted": "yes"}}')) as Out;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Out).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(["<TEXT 9>"]);
  });

  it("remaps ids consistently across keys and inside paths", () => {
    const s = new Scrubber();
    const out = s.value({
      session_id: SID,
      transcript_path: `C:\\Users\\alice\\.claude\\projects\\C--Users-alice-projects-demo\\${SID}.jsonl`,
      agent_id: "0123456789abcdef0",
      tool_use_id: "toolu_01ABCdefGHIjklMNOpqr12",
      prompt_id: "not an id",
    }) as Out;
    expect(out.session_id).toBe(mapId(SID));
    expect(out.transcript_path).toBe(`<HOME>/.claude/projects/<PROJECT_A>/${mapId(SID)}.jsonl`);
    expect(out.agent_id).toBe(mapId("0123456789abcdef0"));
    expect(out.tool_use_id).toMatch(/^toolu_/);
    expect(out.prompt_id).toBe("<TEXT 9>");
  });

  it("is deterministic across instances and counts denied paths", () => {
    const input = { prompt: "abc", cwd: "C:/Users/a/projects/p", tool_input: { command: "ls" } };
    const a = new Scrubber();
    const b = new Scrubber();
    expect(JSON.stringify(a.value(input))).toBe(JSON.stringify(b.value(input)));
    expect([...a.denied]).toEqual([
      ["prompt", 1],
      ["tool_input.command", 1],
    ]);
  });

  it("falls back to a placeholder for a path key holding a non-path value", () => {
    const s = new Scrubber();
    expect(s.value({ cwd: "not a path" })).toEqual({ cwd: "<TEXT 10>" });
  });

  it("does not mutate its input", () => {
    const input = { prompt: "abc", nested: { message: "def" } };
    const copy = structuredClone(input);
    new Scrubber().value(input);
    expect(input).toEqual(copy);
  });
});
