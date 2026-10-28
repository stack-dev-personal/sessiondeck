// Synthetic input only: every name, path and zone below is invented or generic.
// Security gate round 3 follow-ups (R0.7): time zones, home-relative private paths, writes into
// private files.
import { describe, expect, it } from "vitest";
import { Mapper } from "../lib/fixture-scrub-paths.mjs";
import {
  checkTranscriptStructure,
  newContext,
  primeContext,
} from "../lib/transcript-leak-structure.mjs";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import { cutPrivateText, privateTextFinding } from "../lib/transcript-scrub-cuts.mjs";
import {
  climbsAbove,
  isOutsideProject,
  isPrivateCommand,
  isPrivateSpelling,
  isPrivateToolUse,
} from "../lib/transcript-scrub-private.mjs";
import { hasZone, scrubZones } from "../lib/transcript-scrub-zone.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

const OWN = "C:/Users/zorbo/projects/demo";
const SECRET = "zzprivate body text";

function scrubber(): TranscriptScrubber {
  const mapper = new Mapper();
  mapper.seedProjects([OWN]);
  return new TranscriptScrubber({ mapper, literals: { users: ["zorbo"] } });
}

/** Scrubs a call row and its result row together; returns the scrubbed pair. */
function pair(name: string, input: Out): [Out, Out] {
  const call: Out = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a1", name, input }] },
  };
  const result: Out = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_a1", content: SECRET }],
    },
    toolUseResult: { stdout: SECRET },
  };
  const s = scrubber();
  s.prime([call, result]);
  return [s.row(call) as Out, s.row(result) as Out];
}

function checkPair(call: unknown, result: unknown): string[] {
  const hits: string[] = [];
  const ctx = newContext();
  primeContext([call, result], ctx);
  for (const d of [call, result]) checkTranscriptStructure(d, (c: string) => hits.push(c), ctx);
  return hits;
}

describe("time zones", () => {
  it.each([
    ["resets 11pm (America/New_York)", "resets 11pm (<TZ>)"],
    ["at Europe/Berlin now", "at <TZ> now"],
    ["Etc/GMT+5 and America/Argentina/Buenos_Aires", "<TZ> and <TZ>"],
    ["meet at 5pm PST", "meet at 5pm <TZ>"],
    ["resets 11:30 pm (EDT)", "resets 11:30 pm (<TZ>)"],
    ["at 9 CEST", "at 9 <TZ>"],
    ["daemon (PT) mode", "daemon (<TZ>) mode"],
    ["clock is UTC-5 here", "clock is <TZ> here"],
    ["clock is GMT+5:30 here", "clock is <TZ> here"],
    ["10am Eastern Standard Time", "10am <TZ>"],
  ])("scrubs %s", (input, expected) => {
    expect(scrubZones(input)).toBe(expected);
    expect(hasZone(input)).toBe(true);
    expect(hasZone(expected)).toBe(false);
  });

  it("leaves UTC alone and ordinary words and paths", () => {
    for (const t of [
      "2026-10-28T10:00:00Z in UTC",
      "packages/contract/src/Asia.ts",
      "the pacific ocean, est. 1999, it is best",
      "src/Europe.ts and America",
    ]) {
      expect(scrubZones(t)).toBe(t);
      expect(hasZone(t)).toBe(false);
    }
  });

  it("is applied by the scrub to free text and flagged by the check when left live", () => {
    const row = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "limit resets 11pm (Asia/Tokyo)" }],
      },
    };
    const out = scrubber().row(row) as Out;
    expect(out.message.content[0].text).toBe("limit resets 11pm (<TZ>)");
    expect(hasZone(JSON.stringify(out))).toBe(false);
    expect(hasZone(JSON.stringify(row))).toBe(true);
  });
});

describe("home-relative private paths", () => {
  it.each([
    "Get-Content $env:USERPROFILE\\.claude\\settings.json",
    'cat "$USERPROFILE/.claude/x"',
    "type %USERPROFILE%\\.claude\\x",
    "cat ${HOME}/notes.txt",
    "dir $env:APPDATA",
    "cat ../../.claude/x",
    "cd ..",
    "cat ~/.claude/x",
    "cat ~/notes",
    "cat <ROOT>/<DIR_1>/x.txt",
    "ls .claude",
    "cat .claude/settings.local.json",
  ])("makes %s private", (command) => {
    expect(isPrivateCommand(command)).toBe(true);
    expect(isPrivateToolUse("Bash", { command })).toBe(true);
    expect(isPrivateToolUse("PowerShell", { command })).toBe(true);
  });

  it("makes Read paths private by spelling", () => {
    for (const p of [
      "../../.claude/x.md",
      "../x.md",
      ".claude/projects/x.md",
      "%USERPROFILE%\\.claude\\x",
      "$env:USERPROFILE\\.claude\\x",
    ]) {
      expect(isPrivateSpelling(p)).toBe(true);
      expect(isOutsideProject(p)).toBe(true);
      expect(isPrivateToolUse("Read", { file_path: p })).toBe(true);
    }
  });

  it("keeps ordinary in-repo relative paths and tracked .claude folders", () => {
    for (const p of [
      "packages/contract/src/x.ts",
      "./packages/contract/src/x.ts",
      "a/b/../c.ts",
      ".claude/agents/x.md",
      ".claude/skills/y/SKILL.md",
      ".claude/hooks/guard.mjs",
      ".claude/settings.json",
      "<HOME>/projects/<PROJECT_A>/.claude/agents/x.md",
    ]) {
      expect(isOutsideProject(p)).toBe(false);
      expect(isPrivateToolUse("Read", { file_path: p })).toBe(false);
    }
    for (const c of ["cat packages/contract/src/x.ts", "ls .claude/agents", "pnpm -r test"]) {
      expect(isPrivateCommand(c)).toBe(false);
    }
    expect(climbsAbove("a/b/../../c")).toBe(false);
    expect(climbsAbove("a/../../c")).toBe(true);
  });

  it.each([
    ["Bash", { command: "Get-Content $env:USERPROFILE\\.claude\\settings.json" }],
    ["Bash", { command: 'cat "$USERPROFILE/.claude/x"' }],
    ["Bash", { command: "type %USERPROFILE%\\.claude\\x" }],
    ["Read", { file_path: "../../.claude/x.md" }],
    ["Bash", { command: "cat ~/.claude/x" }],
    ["Bash", { command: "cat /usr/share/x.txt" }],
  ])("%s %j: the scrub drops the result and the check fails a live copy", (name, input) => {
    const [call, result] = pair(name, input);
    expect(result.message.content[0].content).toMatch(/^<BLOB \d+>$/);
    expect(result.toolUseResult).toMatch(/^<BLOB \d+>$/);
    expect(checkPair(call, result)).toEqual([]);
    const live = {
      ...result,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: call.message.content[0].id, content: "x" }],
      },
    };
    expect(checkPair(call, live)).toContain("transcript-private-content-not-blob");
  });

  it("keeps the result of a normal in-repo read", () => {
    const [, result] = pair("Read", { file_path: "packages/contract/src/x.ts" });
    expect(result.message.content[0].content).toBe(SECRET);
  });
});

describe("a command that writes into a private path", () => {
  const heredoc = `cat > .sprint/0/answers/decisions.md <<'EOF'\n${SECRET} and more words after`;

  it("is cut after the path", () => {
    const cut = cutPrivateText(heredoc);
    expect(cut).toMatch(/^cat > \.sprint\/0\/answers\/decisions\.md <BLOB \d+>$/);
    expect(cut).not.toContain("zzprivate");
    expect(privateTextFinding(cut)).toBeNull();
    expect(cutPrivateText(cut)).toBe(cut);
  });

  it("covers tee, append, quotes and PowerShell cmdlets", () => {
    for (const c of [
      `tee -a .sprint/x.log <<< ${SECRET}`,
      `cat >> "$HOME/.claude/notes.md" <<EOT
${SECRET}`,
      `Set-Content -Path $env:USERPROFILE\\.claude\\x ${SECRET}`,
      `cat > ../../out.txt <<EOT
${SECRET}`,
    ]) {
      const cut = cutPrivateText(c);
      expect(cut).not.toContain("zzprivate");
      expect(cut).toMatch(/ <BLOB \d+>$/);
      expect(privateTextFinding(cut)).toBeNull();
    }
  });

  it("the check fails a live heredoc", () => {
    expect(privateTextFinding(heredoc)).toBe("transcript-private-text-not-cut");
    const truncated = `${heredoc.slice(0, 80)}<TRUNCATED 400>`;
    expect(privateTextFinding(truncated)).toBe("transcript-private-text-not-cut");
  });

  it("leaves writes to public targets and /dev/null alone", () => {
    for (const c of [
      `cat > packages/contract/src/x.ts <<'EOF'\n${SECRET}`,
      `ls missing 2>/dev/null; echo ${SECRET}`,
      `echo ${SECRET} > <ROOT>/<DIR_1>/null`,
      "pnpm test 2>&1 | tail -5",
    ]) {
      expect(cutPrivateText(c)).toBe(c);
      expect(privateTextFinding(c)).toBeNull();
    }
  });

  it("is applied by the scrub to a Bash command", () => {
    const row = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_b2", name: "Bash", input: { command: heredoc } }],
      },
    };
    const out = JSON.stringify(scrubber().row(row));
    expect(out).not.toContain("zzprivate");
    expect(out).toContain("decisions.md <BLOB");
  });
});
