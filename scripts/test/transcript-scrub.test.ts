// Synthetic input only: every name, path, email and token below is invented for these tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import { scrubFixture } from "../lib/transcript-scrub-run.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterEach(cleanupTempDirs);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

const LITERALS = { users: ["zorbo"], emails: ["zed@example.test"], accounts: ["acme-org"] };
const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-8999-000000000000";

const scrub = (row: unknown, s = new TranscriptScrubber({ literals: LITERALS })) =>
  s.row(row) as Out;

/** A user row whose message content is one string (free text). */
const userRow = (content: string): Out => ({
  type: "user",
  uuid: UUID_A,
  parentUuid: UUID_B,
  message: { role: "user", content },
});

describe("free text", () => {
  it("cuts at 120 characters with the original length in the marker", () => {
    const text = "word ".repeat(40); // 200 characters
    const out = scrub(userRow(text));
    expect(out.message.content).toBe(`${text.slice(0, 120)}<TRUNCATED 200>`);
  });

  it("does not cut at or under 120 characters", () => {
    const at = "ab ".repeat(40); // exactly 120
    const under = "short prompt";
    expect(at).toHaveLength(120);
    expect(scrub(userRow(at)).message.content).toBe(at);
    expect(scrub(userRow(under)).message.content).toBe(under);
  });

  it("scrubs before it cuts, so a token in the kept prefix is redacted", () => {
    const text = `use sk-abcdef0123456789abcdef in the call ${"x ".repeat(80)}`;
    const out = scrub(userRow(text)).message.content as string;
    expect(out).toContain("<REDACTED>");
    expect(out).not.toContain("sk-abcdef");
    expect(out).toMatch(/<TRUNCATED \d+>$/);
  });

  it("redacts the other token shapes anywhere in a string", () => {
    const raw = [
      "ghp_0123456789abcdefABCDEF",
      "AKIA0123456789ABCDEF",
      "xoxb-0123456789-abcdef",
      "Authorization: Bearer abcDEF0123456789token",
      "0123456789abcdef0123456789abcdef0123",
    ].join(" | ");
    const out = scrub(userRow(raw)).message.content as string;
    for (const bit of ["ghp_", "AKIA0", "xoxb-", "abcDEF0123", "0123456789abcdef0123"]) {
      expect(out).not.toContain(bit);
    }
  });
});

describe("thinking and signatures", () => {
  it("replaces thinking and signature, keeps the block type", () => {
    const row = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning", signature: "c2lnbmF0dXJl" },
          { type: "redacted_thinking", data: "ZGF0YQ==" },
          { type: "text", text: "hello", signature: "other" },
        ],
      },
    };
    const out = scrub(row);
    expect(out.message.content[0]).toEqual({
      type: "thinking",
      thinking: "<REDACTED-THINKING>",
      signature: "<REDACTED-THINKING>",
    });
    expect(out.message.content[1]).toEqual({
      type: "redacted_thinking",
      data: "<REDACTED-THINKING>",
    });
    expect(out.message.content[2].signature).toBe("<REDACTED-THINKING>");
    expect(out.message.content[2].text).toBe("hello");
  });
});

describe("dropped subtrees", () => {
  it("replaces a base64 image source payload, keeping type and media_type", () => {
    const data = "iVBORw0KGgo".repeat(30);
    const row = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    const src = scrub(row).message.content[0].source;
    expect(src.type).toBe("base64");
    expect(src.media_type).toBe("image/png");
    expect(src.data).toBe(`<BLOB ${data.length}>`);
  });

  it("replaces wire payloads and tool schemas with <BLOB n> and keeps scalar neighbours", () => {
    const wire = { a: [1, 2, 3], b: "payload text" };
    const row = { type: "api-request", wireToolInputs: wire, keep: 3, systemPrompt: ["x"] };
    const s = new TranscriptScrubber();
    const out = scrub(row, s);
    expect(out.wireToolInputs).toBe(`<BLOB ${JSON.stringify(wire).length}>`);
    expect(out.systemPrompt).toBe(`<BLOB ${JSON.stringify(["x"]).length}>`);
    expect(out.keep).toBe(3);
    expect([...s.dropped.keys()].sort()).toEqual(["systemPrompt", "wireToolInputs"]);
  });

  it("drops the top-level shape of api-request-shape rows only", () => {
    const out = scrub({ type: "api-request-shape", shape: { k: "v" }, shapeHash: "a".repeat(64) });
    expect(out.shape).toMatch(/^<BLOB \d+>$/);
    expect(out.shapeHash).toBe("<REDACTED>");
  });
});

describe("paths", () => {
  const forms = [
    "C:\\Users\\zorbo\\projects\\secretapp\\src\\a.ts",
    "c:/users/zorbo/projects/secretapp/src/a.ts",
    "/c/Users/zorbo/projects/secretapp/src/a.ts",
    "C:\\\\Users\\\\zorbo\\\\projects\\\\secretapp\\\\src\\\\a.ts",
    "C%3A%5CUsers%5Czorbo%5Cprojects%5Csecretapp%5Csrc%5Ca.ts",
    "/home/zorbo/projects/secretapp/src/a.ts",
    "C--Users-zorbo-projects-secretapp",
  ];

  it.each(forms)("maps %s to <HOME> and removes the user and project names", (form) => {
    const out = scrub(userRow(`open ${form} now`)).message.content as string;
    expect(out).toMatch(/<HOME>|<PROJECT_[A-Z]>/);
    expect(out).not.toMatch(/zorbo/i);
    expect(out).not.toContain("secretapp");
    expect(out).not.toMatch(/Users/i);
  });

  it("maps path-valued fields: cwd to <HOME> form and other roots to <ROOT>", () => {
    const out = scrub({
      type: "user",
      cwd: "C:\\Users\\zorbo\\projects\\secretapp",
      attachment: { type: "x", filename: "D:\\data\\private\\notes.txt" },
    });
    expect(out.cwd).toMatch(/^<HOME>\/projects\/<PROJECT_[A-Z]>$/);
    expect(out.attachment.filename).toMatch(/^<ROOT>\/<DIR_\d+>\/<DIR_\d+>\/<FILE_\d+>\.txt$/);
    expect(JSON.stringify(out)).not.toMatch(/zorbo|secretapp|private/);
  });

  it("replaces the user name inside longer words", () => {
    const out = scrub(userRow("host ZORBOBOOK says hi")).message.content as string;
    expect(out).not.toMatch(/zorbo/i);
  });
});

describe("accounts and ids", () => {
  it("replaces emails, userEmail, organizationUuid and request ids", () => {
    const out = scrub({
      type: "attachment",
      attachment: {
        type: "session_context",
        context: {
          userEmail: "someone@corp.example",
          gitStatus: "mail me at zed@example.test or a.b@c.io",
        },
        organizationUuid: UUID_A,
      },
      requestId: "req_011CgT1wTAJfKwSghngasFrL",
    });
    expect(out.attachment.context.userEmail).toBe("<EMAIL>");
    expect(out.attachment.context.gitStatus).toBe("mail me at <EMAIL> or <EMAIL>");
    expect(out.attachment.organizationUuid).toBe("<ACCOUNT>");
    expect(out.requestId).toBe("<REQUEST_ID>");
  });

  it("replaces repository owners in URLs and discovered account names", () => {
    const out = scrub({
      type: "pr-link",
      prRepository: "acme-org/widgets",
      prUrl: "https://github.com/acme-org/widgets/pull/42",
    });
    expect(out.prRepository).toBe("<ACCOUNT>/<REPO>");
    expect(out.prUrl).toBe("https://github.com/<ACCOUNT>/<REPO>/pull/42");
    const text = scrub(userRow("see github.com/other-org/x and acme-org here")).message.content;
    expect(text).toBe("see github.com/<ACCOUNT>/x and <ACCOUNT> here");
  });

  it("keeps ids and parent links verbatim", () => {
    const row = {
      type: "assistant",
      uuid: UUID_A,
      parentUuid: UUID_B,
      logicalParentUuid: UUID_B,
      sessionId: UUID_A,
      agentId: "a0123456789abcdef",
      isSidechain: true,
      message: {
        id: "msg_011CgT1wTAJfKwSghngasFrL",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_01Wmng61FQaUkCGPzp3E1161", name: "Read", input: {} },
        ],
      },
      timestamp: "2026-10-27T15:57:44.054Z",
      version: "2.1.311",
    };
    expect(scrub(row)).toEqual(row);
  });

  it("replaces an id that fails its pattern", () => {
    const out = scrub({ type: "user", uuid: "has spaces and personal text" });
    expect(out.uuid).toBe("<TEXT 28>");
  });
});

describe("names", () => {
  it("keeps built-in tools, numbers MCP tools and custom agent types", () => {
    const block = (name: string) => ({ type: "tool_use", id: "toolu_01aaaaaaaaaaaaaaaa", name });
    const out = scrub({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          block("Bash"),
          block("mcp__private_server__do_thing"),
          block("mcp__private_server__other"),
          { ...block("Agent"), input: { subagent_type: "my-private-agent" } },
        ],
      },
    });
    const c = out.message.content;
    expect(c[0].name).toBe("Bash");
    expect(c[1].name).toBe("mcp__<MCP_1>__<TOOL_1>");
    expect(c[2].name).toBe("mcp__<MCP_1>__<TOOL_2>");
    expect(c[3].input.subagent_type).toBe("<AGENT_1>");
  });

  it("numbers MCP tool names that appear in free text", () => {
    const out = scrub(userRow("call mcp__private_server__do_thing now")).message.content;
    expect(out).toBe("call mcp__<MCP_1>__<TOOL_1> now");
  });

  it("keeps a branch only in this repo's public shapes", () => {
    expect(scrub({ type: "user", gitBranch: "p0/transcript-fixtures" }).gitBranch).toBe(
      "p0/transcript-fixtures",
    );
    expect(scrub({ type: "user", gitBranch: "main" }).gitBranch).toBe("main");
    expect(scrub({ type: "user", gitBranch: "feature/acme-secret" }).gitBranch).toBe("<TEXT 19>");
  });
});

describe("default deny", () => {
  it("fails closed on an unknown key: key placeholder, value never passes through, reported", () => {
    const s = new TranscriptScrubber();
    const out = scrub(
      { type: "user", surpriseKey: "private value", attachment: { type: "x", novelField: "text" } },
      s,
    );
    expect(Object.keys(out)).toEqual(["type", "<KEY_1>", "attachment"]);
    expect(out["<KEY_1>"]).toBe("<TEXT 13>");
    expect(out.attachment.type).toBe("x");
    expect(out.attachment["<KEY_1>"]).toBe("<TEXT 4>");
    expect(JSON.stringify(out)).not.toMatch(/surpriseKey|private value|novelField/);
    expect(s.unknownKeys.size).toBe(2);
  });

  it("replaces a string outside the free-text zones with <TEXT n>", () => {
    const s = new TranscriptScrubber();
    const out = scrub({ type: "user", slug: "not a slug at all" }, s);
    expect(out.slug).toBe("<TEXT 17>");
    expect(s.denied.get("slug")).toBe(1);
  });

  it("turns non-identifier key names into placeholders", () => {
    const out = scrub({ type: "user", toolUseResult: { "my file.txt": "x" } });
    expect(Object.keys(out.toolUseResult)).toEqual(["<TEXT 11>"]);
  });

  it("keeps numbers, booleans and null", () => {
    const row = {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "x", container: null },
    };
    expect(scrub(row)).toEqual(row);
  });
});

describe("fixture run", () => {
  function makeRaw(): string {
    const raw = makeTempDir();
    const dir = join(raw, "01-demo");
    mkdirSync(join(dir, "subagents"), { recursive: true });
    const rows = [
      {
        type: "user",
        uuid: UUID_A,
        parentUuid: null,
        cwd: "C:\\Users\\zorbo\\projects\\demo",
        version: "2.1.1",
        message: { role: "user", content: "hello there" },
      },
      {
        type: "assistant",
        uuid: UUID_B,
        parentUuid: UUID_A,
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(300) }] },
      },
      {
        type: "system",
        subtype: "turn_duration",
        durationMs: 5,
        uuid: "22222222-3333-4444-8555-666666666666",
      },
    ];
    writeFileSync(join(dir, "session.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    writeFileSync(
      join(dir, "subagents", "agent-a0123456789abcdef.jsonl"),
      `${JSON.stringify({ type: "user", isSidechain: true, agentId: "a0123456789abcdef", message: { role: "user", content: "sub" } })}\n`,
    );
    writeFileSync(
      join(dir, "subagents", "agent-a0123456789abcdef.meta.json"),
      JSON.stringify({
        agentType: "my-agent",
        description: "zorbo task",
        toolUseId: "toolu_01aaaaaaaaaaaaaaaa",
        spawnDepth: 1,
      }),
    );
    return dir;
  }

  it("is deterministic, keeps row counts and order, and writes the README", () => {
    const dir = makeRaw();
    const outA = makeTempDir();
    const outB = makeTempDir();
    const a = scrubFixture(dir, outA, "01-demo", LITERALS);
    const b = scrubFixture(dir, outB, "01-demo", LITERALS);
    expect(a.digest).toBe(b.digest);
    const files = [
      "session.jsonl",
      "subagents/agent-a0123456789abcdef.jsonl",
      "subagents/agent-a0123456789abcdef.meta.json",
      "README.md",
    ];
    for (const f of files) {
      expect(readFileSync(join(outA, "01-demo", f))).toEqual(
        readFileSync(join(outB, "01-demo", f)),
      );
    }
    const rows = readFileSync(join(outA, "01-demo", "session.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => JSON.parse(r).uuid)).toEqual([
      UUID_A,
      UUID_B,
      "22222222-3333-4444-8555-666666666666",
    ]);
    expect(a.st.rows).toBe(4);
    const meta = JSON.parse(
      readFileSync(join(outA, "01-demo", "subagents", "agent-a0123456789abcdef.meta.json"), "utf8"),
    );
    expect(meta.agentType).toBe("<AGENT_1>");
    const all = files.map((f) => readFileSync(join(outA, "01-demo", f), "utf8")).join("\n");
    expect(all).not.toMatch(/zorbo/i);
    const readme = readFileSync(join(outA, "01-demo", "README.md"), "utf8");
    expect(readme).toContain("2.1.1");
    expect(readme).toContain("- assistant: 1");
  });

  it("rejects unexpected file names in subagents", () => {
    const dir = makeRaw();
    writeFileSync(join(dir, "subagents", "notes.txt"), "x");
    expect(() => scrubFixture(dir, makeTempDir(), "01-demo", LITERALS)).toThrow(
      /unexpected file name/,
    );
  });
});
