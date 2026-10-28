// Synthetic input only: every name, path, email, token and deny word below is invented.
// Security gate fix (R0.7): deny-list, handle substrings, secret shapes, ids, agent names, and the
// structural leak checks that need no secrets (what CI runs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countDenyHits,
  DENY_FILE,
  loadDenyWords,
  parseDenyWords,
} from "../lib/transcript-deny-list.mjs";
import { transcriptLeakCheck } from "../lib/transcript-leak-core.mjs";
import {
  newContext,
  primeContext,
  checkTranscriptStructure,
} from "../lib/transcript-leak-structure.mjs";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import { deriveFragments } from "../lib/transcript-scrub-fragments.mjs";
import { discoverLiterals } from "../lib/transcript-scrub-literals.mjs";
import { deriveMcpServers, deriveRepos } from "../lib/transcript-scrub-names.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterEach(cleanupTempDirs);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;
const UUID = "11111111-2222-4333-8444-555555555555";
const userRow = (content: string): Out => ({
  type: "user",
  uuid: UUID,
  message: { role: "user", content },
});
const text = (literals: object, s: string): string =>
  (new TranscriptScrubber({ literals }).row(userRow(s)) as Out).message.content;

describe("local deny-list", () => {
  it("parses words: trimmed, lower-cased, unique, longest first, comments and short words skipped", () => {
    expect(parseDenyWords("# note\n  Quuxword \nQUUXWORD\nab\n\nzzfoo-bar\r\n")).toEqual([
      "zzfoo-bar",
      "quuxword",
    ]);
  });

  it("loads raw/deny-words.txt, and returns nothing without raw/ or the file", () => {
    const raw = makeTempDir();
    expect(loadDenyWords(raw)).toEqual([]);
    expect(loadDenyWords(null)).toEqual([]);
    writeFileSync(join(raw, DENY_FILE), "quuxword\n");
    expect(loadDenyWords(raw)).toEqual(["quuxword"]);
  });

  it("counts case-insensitive substring hits without returning the match", () => {
    expect(countDenyHits("a QuuxWord b xquuxwordx", ["quuxword"])).toBe(2);
    expect(countDenyHits("nothing", ["quuxword"])).toBe(0);
    expect(countDenyHits("anything", [])).toBe(0);
  });

  it("the scrub replaces a deny word anywhere in free text, in any case, inside words", () => {
    const out = text({ denyWords: ["quuxword"] }, "see QuuxWord and xquuxwordy now");
    expect(out).toBe("see <DENY> and x<DENY>y now");
  });

  it("an enum-shaped value holding a deny word is denied, not kept", () => {
    const s = new TranscriptScrubber({ literals: { denyWords: ["quuxword"] } });
    const out = s.row({ type: "system", subtype: "ok", level: "quuxword-level" }) as Out;
    expect(out.level).toMatch(/^<TEXT \d+>$/);
    expect(out.subtype).toBe("ok");
  });

  it("the leak check fails on a planted deny word and passes without the list", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "01-demo"), { recursive: true });
    const row = userRow("planted QuuxWord here");
    writeFileSync(join(dir, "01-demo", "session.jsonl"), `${JSON.stringify(row)}\n`);
    const withList = transcriptLeakCheck(dir, { vocabulary: " ", denyWords: ["quuxword"] });
    expect(withList.byCategory["transcript-deny-word"]).toBe(1);
    expect(withList.literals.deny).toBe(1);
    expect(transcriptLeakCheck(dir, { vocabulary: " " }).byCategory).toEqual({});
  });
});

describe("handle substrings", () => {
  it("derives every substring of 5+ characters of a handle", () => {
    const f = deriveFragments(["emzorbonaut-su"]);
    expect(f).toEqual(expect.arrayContaining(["zorbo", "orbon", "zorbonaut", "bonaut"]));
    expect(f.every((p) => p.length >= 5)).toBe(true);
  });

  it("sweeps a surname piece that sits inside a longer handle", () => {
    const literals = {
      accounts: ["emzorbonaut-su"],
      fragments: deriveFragments(["emzorbonaut-su"]),
    };
    const out = text(literals, "grep for 'bonaut' and 'zorbon' in the set");
    expect(out).not.toMatch(/bonaut|zorbon/);
  });

  it("skips substrings that are part of a schema word", () => {
    const f = deriveFragments(["xxuserSettingsxx"]);
    expect(f).not.toContain("setti");
    expect(f).not.toContain("userse");
  });

  it("discoverLiterals feeds the substrings from a discovered handle", () => {
    const lit = discoverLiterals(
      [{ type: "attachment", attachment: { context: { userEmail: "emquuxling7@corp.example" } } }],
      " ",
      () => "",
      () => "synthbox",
    );
    expect(lit.fragments).toEqual(expect.arrayContaining(["quuxl", "uuxli"]));
  });
});

describe("secret shapes", () => {
  const red = (s: string): string => text({}, s);

  it("redacts prefixed key names such as access_token and client_secret", () => {
    for (const s of [
      "access_token=abcdef123456",
      "client_secret: 'Zk39sd8f7g6h'",
      "refresh_token=abcdef123456",
      "MY_API_KEY=xyz12345",
    ]) {
      expect(red(s)).toContain("<REDACTED>");
      expect(red(s)).not.toMatch(/abcdef123456|Zk39sd8f7g6h|xyz12345/);
    }
  });

  it("redacts Supabase, Cloudflare and credentialed URL shapes", () => {
    for (const s of [
      "key sb_secret_abcdefghijkl1234",
      "key sb_publishable_abcdefghijkl1234",
      `token cfut_${"a1B2".repeat(7)}`,
      "url postgres://admin:hunter22pw@db.example.test/app",
    ]) {
      expect(red(s)).toContain("<REDACTED>");
    }
    expect(red("postgres://admin:hunter22pw@db")).not.toContain("hunter22pw");
  });

  it("redacts a long lowercase-and-digits run and an assigned alphanumeric run", () => {
    expect(red(`id ${"a1b2c3d4".repeat(5)} end`)).toContain("<REDACTED>");
    expect(red("SOMEVAR=ab12cd34ef56gh78ij90kl12mn")).toContain("<REDACTED>");
  });

  it("keeps a long kebab-case name and plain prose", () => {
    const kebab = "p0-transcript-fixtures-security-gate-fix-round-1";
    expect(red(`branch ${kebab} ok`)).toContain(kebab);
    expect(red("the token budget is large")).toBe("the token budget is large");
  });
});

describe("ids, agent names and MCP names", () => {
  it("keeps known id shapes and denies a free-form id in a tool input", () => {
    const out = new TranscriptScrubber().row({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_01abcdef",
            name: "Bash",
            input: { id: "hello-world-word" },
          },
        ],
      },
    }) as Out;
    expect(out.message.content[0].id).toBe("toolu_01abcdef");
    expect(out.message.content[0].input.id).toMatch(/^<TEXT \d+>$/);
  });

  it("numbers custom agent names in addedTypes and querySource like agentType", () => {
    const out = new TranscriptScrubber().row({
      type: "attachment",
      querySource: "agent:custom:my-private-agent",
      agentType: "my-private-agent",
      attachment: { type: "agent_listing_delta", addedTypes: ["Explore", "my-private-agent"] },
    }) as Out;
    expect(out.agentType).toBe("<AGENT_1>");
    expect(out.querySource).toBe("agent:custom:<AGENT_1>");
    expect(out.attachment.addedTypes).toEqual(["Explore", "<AGENT_1>"]);
    expect(
      (new TranscriptScrubber().row({ type: "user", querySource: "repl_main_thread" }) as Out)
        .querySource,
    ).toBe("repl_main_thread");
  });

  it("maps known server names in free text through the same numbering as tool names", () => {
    const out = text(
      { mcpServers: ["claude_ai_Linear", "zephyr"] },
      "claude.ai Linear and Zephyr failed",
    );
    expect(out).toBe("<MCP_1> and <MCP_2> failed");
  });

  it("derives server names from tool names and server lists, repo names from URLs and gh loops", () => {
    const rows = [
      { message: { content: [{ type: "tool_use", name: "mcp__zephyr__ping" }] } },
      { attachment: { failedMcpServers: [{ name: "quill-srv" }] } },
      {
        content:
          "git clone https://github.com/acme/hidden-repo.git; gh api repos/acme/other-repo/x; " +
          "for r in public-one secret-two; do gh api repos/acme/$r; done",
      },
    ];
    expect(deriveMcpServers(rows)).toEqual(["quill-srv", "zephyr"]);
    expect(deriveRepos(rows, "public-one")).toEqual(["hidden-repo", "other-repo", "secret-two"]);
  });
});

describe("structural leak checks without secrets (CI)", () => {
  const findings = (docs: Out[]): string[] => {
    const out: string[] = [];
    const ctx = newContext();
    primeContext(docs, ctx);
    for (const d of docs) checkTranscriptStructure(d, (c: string) => out.push(c), ctx);
    return out.sort();
  };
  const att = (attachment: Out): Out => ({ type: "attachment", attachment });
  const BLOB = "<BLOB 12>";

  it("fails on live content next to a path outside the project, passes on a BLOB or own file", () => {
    const live = att({ type: "nested_memory", path: "<HOME>/.claude/<FILE_1>.md", content: "x" });
    const own = att({
      type: "file",
      filename: "<HOME>/projects/<PROJECT_A>/<FILE_1>.ts",
      content: "x",
    });
    expect(findings([live])).toEqual(["transcript-private-content-not-blob"]);
    expect(findings([{ ...live, attachment: { ...live.attachment, content: BLOB } }])).toEqual([]);
    expect(findings([own])).toEqual([]);
  });

  it("fails on live addedBlocks, addedLines, skill_listing content and hook output", () => {
    expect(findings([att({ type: "mcp_instructions_delta", addedBlocks: ["x"] })])).toEqual([
      "transcript-dropped-key-not-blob",
    ]);
    expect(findings([att({ type: "agent_listing_delta", addedLines: ["x"] })])).toEqual([
      "transcript-dropped-key-not-blob",
    ]);
    expect(findings([att({ type: "skill_listing", content: "x" })])).toEqual([
      "transcript-dropped-key-not-blob",
    ]);
    expect(findings([att({ type: "hook_additional_context", content: ["x"] })])).toEqual([
      "transcript-dropped-key-not-blob",
    ]);
    expect(
      findings([att({ type: "hook_success", hookEvent: "SessionStart", stdout: "x" })]),
    ).toEqual(["transcript-dropped-key-not-blob"]);
    expect(
      findings([att({ type: "hook_success", hookEvent: "SessionStart", stdout: BLOB })]),
    ).toEqual([]);
  });

  it("fails on live output of a tool use that touched a private path", () => {
    const use: Out = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_0001aaaa",
            name: "Read",
            input: { file_path: "<HOME>/.claude/<FILE_1>.md" },
          },
        ],
      },
    };
    const result = (content: string, toolUseResult: string): Out => ({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_0001aaaa", content }],
      },
      toolUseResult,
    });
    expect(findings([use, result("live", BLOB)])).toEqual(["transcript-private-content-not-blob"]);
    expect(findings([use, result(BLOB, "live")])).toEqual(["transcript-private-content-not-blob"]);
    expect(findings([use, result(BLOB, BLOB)])).toEqual([]);
  });

  it("fails on an MCP server name in free text and accepts a placeholder", () => {
    expect(findings([userRow("the MCP server zephyr failed")])).toEqual([
      "transcript-mcp-name-in-text",
    ]);
    expect(findings([userRow("the MCP server <MCP_1> failed")])).toEqual([]);
  });

  it("fails on a custom agent name in querySource and a free-form id", () => {
    expect(findings([{ type: "user", querySource: "agent:custom:my-agent" }])).toEqual([
      "transcript-string-not-allowlisted",
    ]);
    expect(
      findings([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "free form id", name: "Bash" }],
          },
        },
      ]),
    ).toEqual(["transcript-string-not-allowlisted"]);
  });
});
