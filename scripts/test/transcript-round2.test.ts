// Synthetic input only: every name, path, email, token and server name below is invented.
// Security gate round 2 (R0.7): private content through rendered[] and message text, hook text,
// whole-word account sweep, literal shapes, glued home paths, unmapped mcp names, .sprint/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_SHAPES } from "../lib/fixture-leak-patterns.mjs";
import { Mapper } from "../lib/fixture-scrub-paths.mjs";
import { transcriptLeakCheck } from "../lib/transcript-leak-core.mjs";
import { countUnmappedMcpNames } from "../lib/transcript-leak-mcp.mjs";
import { checkTranscriptStructure } from "../lib/transcript-leak-structure.mjs";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import { cutPrivateText, privateTextFinding } from "../lib/transcript-scrub-cuts.mjs";
import { deriveFragments } from "../lib/transcript-scrub-fragments.mjs";
import { discoverLiterals, isAddress, isHandle } from "../lib/transcript-scrub-literals.mjs";
import { isOutsideProject } from "../lib/transcript-scrub-private.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterEach(cleanupTempDirs);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

const HOME = "C:/Users/zorbo";
const OWN = `${HOME}/projects/demo`;
const SECRET = "zzprivate heading and zzprivate body";

function scrubber(literals: object = { users: ["zorbo"] }): TranscriptScrubber {
  const mapper = new Mapper();
  mapper.seedProjects([OWN]);
  return new TranscriptScrubber({ mapper, literals });
}

/** Findings the structure check reports for one scrubbed row. */
function findings(row: unknown): string[] {
  const hits: string[] = [];
  checkTranscriptStructure(row, (c: string) => hits.push(c));
  return hits;
}

const attRow = (attachment: Out, rendered: string[]): Out => ({
  type: "attachment",
  attachment,
  rendered: rendered.map((content) => ({ content })),
  renderedRole: "user",
});

describe("rendered[] copy of a private attachment", () => {
  const outside = {
    type: "nested_memory",
    path: `${HOME}/.claude/CLAUDE.md`,
    content: { path: `${HOME}/.claude/CLAUDE.md`, content: SECRET },
  };

  it("becomes a blob when the attachment path is outside the project", () => {
    const out = scrubber().row(
      attRow(outside, [`Contents of ${HOME}/.claude/CLAUDE.md: ${SECRET}`]),
    );
    expect((out as Out).rendered).toMatch(/^<BLOB \d+>$/);
    expect(JSON.stringify(out)).not.toContain("zzprivate");
    expect(findings(out)).toEqual([]);
  });

  it("the leak check fails when rendered[] keeps the text", () => {
    const out = scrubber().row(attRow(outside, ["x"])) as Out;
    const planted = {
      ...out,
      rendered: [{ content: "Contents of <HOME>/.claude/<FILE_1>.md: x" }],
    };
    expect(findings(planted)).toContain("transcript-private-content-not-blob");
  });

  it("an attachment inside the project keeps its rendered[] text", () => {
    const inside = {
      type: "nested_memory",
      path: `${OWN}/CLAUDE.md`,
      content: { path: `${OWN}/CLAUDE.md` },
    };
    const out = scrubber().row(attRow(inside, ["plain words"])) as Out;
    expect(out.rendered).toEqual([{ content: "plain words" }]);
  });

  it("drops rendered[] of hook rows, and the check fails when it is kept", () => {
    const hook = { type: "hook_success", hookEvent: "SessionStart", stdout: "zzprivate out" };
    const out = scrubber().row(attRow(hook, ["SessionStart hook success: zzprivate out"])) as Out;
    expect(out.rendered).toMatch(/^<BLOB \d+>$/);
    expect(findings(out)).toEqual([]);
    const planted = { ...out, rendered: [{ content: "SessionStart hook success: <BLOB 3>" }] };
    expect(findings(planted)).toContain("transcript-private-content-not-blob");
  });
});

describe("message text of private reads and hooks", () => {
  it("cuts 'Contents of <outside path>:' down to its label", () => {
    const out = cutPrivateText(
      `<system-reminder>\nContents of <HOME>/.claude/<FILE_1>.md: ${SECRET}`,
    );
    expect(out).toMatch(/Contents of <HOME>\/\.claude\/<FILE_1>\.md: <BLOB \d+>$/);
    expect(out).not.toContain("zzprivate");
  });

  it("keeps 'Contents of' for a file inside the project", () => {
    const text = "Contents of <HOME>/projects/<PROJECT_A>/<FILE_1>.md: fine";
    expect(cutPrivateText(text)).toBe(text);
  });

  it("the scrub applies the cut to message text, and the check fails on a planted copy", () => {
    const row = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: `Contents of ${HOME}/.claude/rules/x.md: ${SECRET}` }],
      },
    };
    const out = scrubber().row(row) as Out;
    expect(out.message.content[0].text).toMatch(/: <BLOB \d+>$/);
    expect(findings(out)).toEqual([]);
    const planted = {
      ...row,
      message: {
        role: "user",
        content: [{ type: "text", text: "Contents of <HOME>/.claude/<FILE_1>.md: heading" }],
      },
    };
    expect(findings(planted)).toContain("transcript-private-text-not-cut");
  });

  it("cuts hook labels down to the label, and the check fails on a planted copy", () => {
    for (const label of [
      "SessionStart hook additional context:",
      "PostToolUse:Read hook success:",
    ]) {
      const cut = cutPrivateText(`<system-reminder>\n${label} ${SECRET}`);
      expect(cut).toMatch(/hook [a-z ]+: <BLOB \d+>$/);
      expect(privateTextFinding(cut)).toBeNull();
      expect(privateTextFinding(`${label} some words`)).toBe("transcript-hook-text-not-cut");
    }
  });

  it("cuts 'Result of calling the Read tool:' after a private call, in the next block", () => {
    const call = `Called the Read tool with the following input: {"file_path":"${HOME}/.claude/CLAUDE.md"}`;
    const row = {
      type: "attachment",
      attachment: { type: "file", filename: `${OWN}/x.md` },
      rendered: [{ content: call }, { content: `Result of calling the Read tool:\n1\t${SECRET}` }],
    };
    const out = scrubber().row(row) as Out;
    expect(out.rendered[1].content).toMatch(/^Result of calling the Read tool: <BLOB \d+>$/);
    expect(findings(out)).toEqual([]);
    const planted = {
      ...out,
      rendered: [out.rendered[0], { content: "Result of calling the Read tool:\n1\theading" }],
    };
    expect(findings(planted)).toContain("transcript-private-text-not-cut");
  });

  it("keeps the result block after a read inside the project", () => {
    const call = `Called the Read tool with the following input: {"file_path":"${OWN}/a.md"}`;
    const row = {
      rendered: [{ content: call }, { content: "Result of calling the Read tool:\n1\tok" }],
    };
    const out = scrubber().row(row) as Out;
    expect(out.rendered[1].content).toContain("1\tok");
  });
});

describe("whole-word sweep of account fragments", () => {
  const literals = {
    accounts: ["marigold.wexford42"],
    fragments: deriveFragments(["marigold.wexford42"]),
  };
  const run = (s: string) =>
    (scrubber(literals).row({ type: "user", message: { role: "user", content: s } }) as Out).message
      .content as string;

  it("replaces the whole word around a piece, so no letters stay beside the placeholder", () => {
    const out = run("see xmarigoldy and wexfordshire today");
    expect(out).toBe("see <ACCOUNT> and <ACCOUNT> today");
  });

  it("leaves ordinary words alone", () => {
    expect(run("ordinary words stay")).toBe("ordinary words stay");
  });
});

describe("literal shapes", () => {
  it("accepts handles and plain addresses, rejects sentences and blobs", () => {
    expect(isHandle("some-org")).toBe(true);
    expect(isHandle("two words")).toBe(false);
    expect(isHandle("x".repeat(41))).toBe(false);
    expect(isAddress("a.b@corp.example")).toBe(true);
    expect(isAddress(`${"a".repeat(266)}@corp.example`)).toBe(false);
    expect(isAddress("has space@corp.example")).toBe(false);
  });

  it("does not take junk owner or email values as literals", () => {
    const junkOwner = "some owner phrase here";
    const junkEmail = `${"q".repeat(266)}@corp.example`;
    const lit = discoverLiterals(
      [{ owner: junkOwner, organizationName: "another junk phrase", userEmail: junkEmail }],
      " ",
      () => "",
      () => "synthbox",
    );
    expect(lit.accounts).not.toContain(junkOwner);
    expect(lit.accounts).not.toContain("another junk phrase");
    expect(lit.emails).not.toContain(junkEmail);
    expect(lit.fragments).not.toContain("junk");
    expect(lit.fragments).not.toContain("phrase");
  });

  it("still takes a handle-shaped owner", () => {
    const lit = discoverLiterals(
      [{ owner: "quillfeather-org" }],
      " ",
      () => "",
      () => "synthbox",
    );
    expect(lit.accounts).toContain("quillfeather-org");
  });
});

describe("home path with the separators lost", () => {
  it("is scrubbed to a placeholder", () => {
    const out = (
      scrubber().row({
        type: "user",
        message: { role: "user", content: "see C:Userszorboprojectsdemo now" },
      }) as Out
    ).message.content;
    expect(out).toBe("see <PATH> now");
  });

  it("is flagged by the shared home-path shapes and by the leak check", () => {
    expect(HOME_SHAPES.some((re) => re.test("see C:Userszorbo here"))).toBe(true);
    expect(HOME_SHAPES.some((re) => re.test("type:usersList"))).toBe(false);
    const dir = makeTempDir();
    mkdirSync(join(dir, "01-demo"));
    const row = { type: "user", message: { role: "user", content: "see C:Userszorbo here" } };
    writeFileSync(join(dir, "01-demo", "session.jsonl"), `${JSON.stringify(row)}\n`);
    const r = transcriptLeakCheck(dir, { vocabulary: " " });
    expect(r.byCategory["transcript-home-path-shape"]).toBe(1);
  });
});

describe("unmapped mcp names", () => {
  it("counts a real name and passes placeholders, cut placeholders and prose shapes", () => {
    expect(countUnmappedMcpNames("a mcp__quillsrv__list b")).toBe(1);
    expect(countUnmappedMcpNames("mcp__<MCP_1>__<TOOL_2> and mcp__<MCP_3>")).toBe(0);
    expect(countUnmappedMcpNames("cut mcp__<MCP_1>__<TO<TRUNCATED 300>")).toBe(0);
    expect(countUnmappedMcpNames("named mcp__<server>__<tool>")).toBe(0);
  });

  it("the leak check fails on a planted unmapped name", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "01-demo"));
    const row = { type: "user", message: { role: "user", content: "use mcp__quillsrv__list" } };
    writeFileSync(join(dir, "01-demo", "session.jsonl"), `${JSON.stringify(row)}\n`);
    const r = transcriptLeakCheck(dir, { vocabulary: " " });
    expect(r.byCategory["transcript-mcp-tool-name"]).toBe(1);
  });

  it("the scrub maps a name so the check passes", () => {
    const out = scrubber().row({
      type: "user",
      message: { role: "user", content: "use mcp__quillsrv__list" },
    }) as Out;
    expect(countUnmappedMcpNames(JSON.stringify(out))).toBe(0);
  });
});

describe(".sprint/ counts as outside the project", () => {
  it("isOutsideProject says so for the mapped and the relative form", () => {
    expect(isOutsideProject("<HOME>/projects/<PROJECT_A>/.sprint/<FILE_1>.md")).toBe(true);
    expect(isOutsideProject(".sprint/<FILE_1>.md")).toBe(true);
    expect(isOutsideProject("<HOME>/projects/<PROJECT_A>/src/<FILE_1>.ts")).toBe(false);
  });

  it("drops the contents of a .sprint file and its rendered[] copy, and the check agrees", () => {
    const row = attRow(
      {
        type: "nested_memory",
        path: `${OWN}/.sprint/decisions.md`,
        content: { path: `${OWN}/.sprint/decisions.md`, content: SECRET },
      },
      [`Contents of ${OWN}/.sprint/decisions.md: ${SECRET}`],
    );
    const out = scrubber().row(row) as Out;
    expect(out.attachment.path).toBe("<HOME>/projects/<PROJECT_A>/.sprint/<FILE_1>.md");
    expect(out.attachment.content).toMatch(/^<BLOB \d+>$/);
    expect(out.rendered).toMatch(/^<BLOB \d+>$/);
    expect(findings(out)).toEqual([]);
    const planted = { ...out, attachment: { ...out.attachment, content: "kept words" } };
    expect(findings(planted)).toContain("transcript-private-content-not-blob");
  });

  it("drops the output of a Read of a .sprint file", () => {
    const s = scrubber();
    const use = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_01aaaaaaaaaaaaaaaa",
            name: "Read",
            input: { file_path: `${OWN}/.sprint/log.md` },
          },
        ],
      },
    };
    const res = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01aaaaaaaaaaaaaaaa", content: SECRET },
        ],
      },
    };
    s.prime([use, res]);
    const out = s.row(res) as Out;
    expect(out.message.content[0].content).toMatch(/^<BLOB \d+>$/);
  });
});
