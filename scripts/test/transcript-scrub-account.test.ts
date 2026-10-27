// Synthetic input only: every name, path, email and token below is invented for these tests.
import { describe, expect, it } from "vitest";
import { isStructuralHookName } from "../lib/transcript-scrub-hookname.mjs";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import { deriveFragments } from "../lib/transcript-scrub-fragments.mjs";
import { discoverLiterals } from "../lib/transcript-scrub-literals.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = Record<string, any>;

const ACCOUNTS = ["marigold.wexford42", "Quillfeather"];
const LITERALS = {
  users: ["zorbo"],
  emails: ["marigold.wexford42@corp.example", "quill@users.noreply.example"],
  accounts: ACCOUNTS,
  fragments: deriveFragments(["zorbo", ...ACCOUNTS]),
};
const scrub = (row: unknown): Out => new TranscriptScrubber({ literals: LITERALS }).row(row) as Out;
const userRow = (content: string): Out => ({
  type: "user",
  message: { role: "user", content },
});
const content = (text: string): string => scrub(userRow(text)).message.content as string;

describe("account name fragments", () => {
  it("derives pieces of 5+ characters and skips common words", () => {
    const f = deriveFragments(["marigold.wexford42", "github-admin"]);
    expect(f).toEqual(expect.arrayContaining(["marigold", "wexford", "wexford42"]));
    expect(f).not.toContain("admin");
    expect(f).not.toContain("github");
    expect(f.every((p) => p.length >= 5)).toBe(true);
  });

  it("removes a piece of an account name from free text, any case, inside words", () => {
    const out = content("Ask MARIGOLD about WexfordTeam and wexford_ok plus quillfeathers");
    expect(out).not.toMatch(/marigold|wexford|quillfeather/i);
    expect(out).toContain("<ACCOUNT>");
  });

  it("derives fragments from the local part of a discovered account email", () => {
    const lit = discoverLiterals(
      [
        {
          type: "attachment",
          attachment: { context: { userEmail: "ottoline.brackenridge7@corp.example" } },
        },
      ],
      " ",
    );
    expect(lit.fragments).toEqual(expect.arrayContaining(["ottoline", "brackenridge"]));
  });
});

describe("email forms", () => {
  it("replaces plain, account, noreply and git author email forms", () => {
    const out = content(
      "Author: Zed Q <zed.q@example.test>; mail marigold.wexford42@corp.example; " +
        "12345+quill@users.noreply.example; a+b@sub.domain.io",
    );
    expect(out).not.toContain("@");
    expect(out.match(/<EMAIL>/g)).toHaveLength(4);
  });

  it("replaces an email in a git trailer field of a key-classified value", () => {
    const row = scrub({
      type: "attachment",
      attachment: { type: "session_context", context: { userEmail: "someone@corp.example" } },
    });
    expect(row.attachment.context.userEmail).toBe("<EMAIL>");
  });
});

describe("hook names", () => {
  it.each([
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "Stop",
    "PreToolUse:Bash",
    "PostToolUse:Edit",
  ])("recognizes %s as structural", (name) => {
    expect(isStructuralHookName(name)).toBe(true);
  });

  it.each(["my-private-hook", "PreToolUse:mcp__acme__thing", "PreToolUse:secretTool", "", 5])(
    "does not treat %s as structural",
    (name) => {
      expect(isStructuralHookName(name)).toBe(false);
    },
  );

  it("keeps structural hook names verbatim and numbers the rest", () => {
    const s = new TranscriptScrubber({ literals: LITERALS });
    const hook = (hookName: string) =>
      (s.row({ type: "attachment", attachment: { type: "hook_success", hookName } }) as Out)
        .attachment.hookName;
    expect(hook("PreToolUse:Bash")).toBe("PreToolUse:Bash");
    expect(hook("SessionStart")).toBe("SessionStart");
    expect(hook("acme-secret-hook")).toMatch(/^<NAME_\d+>$/);
    expect(hook("PreToolUse:acme-matcher")).toMatch(/^<NAME_\d+>$/);
    expect(hook("acme-secret-hook")).toBe(hook("acme-secret-hook"));
  });
});

describe("determinism and idempotence", () => {
  it("scrubbing the same rows twice with fresh scrubbers is byte-identical", () => {
    const rows = [
      userRow("see C:/Users/zorbo/projects/x/a.ts and Marigold " + "z ".repeat(100)),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "t", signature: "s" }],
        },
      },
    ];
    const run = () =>
      JSON.stringify(rows.map((r) => new TranscriptScrubber({ literals: LITERALS }).row(r)));
    expect(run()).toBe(run());
  });
});
