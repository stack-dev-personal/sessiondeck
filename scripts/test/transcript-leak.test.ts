// Synthetic input only: every name, path, email and token below is invented for these tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcriptLeakCheck } from "../lib/transcript-leak-core.mjs";
import { TranscriptScrubber } from "../lib/transcript-scrub-core.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterEach(cleanupTempDirs);

const UUID = "11111111-2222-4333-8444-555555555555";
const NO_VOCAB = " ";

/** A user row with one free-text content string. */
const userRow = (content: string): Record<string, unknown> => ({
  type: "user",
  uuid: UUID,
  message: { role: "user", content },
});
const assistantRow = (block: Record<string, unknown>): Record<string, unknown> => ({
  type: "assistant",
  uuid: UUID,
  message: { role: "assistant", content: [block] },
});

const jsonl = (rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** Writes <dir>/01-demo/session.jsonl and returns the transcripts dir. */
function plant(rows: unknown[]): string {
  const dir = makeTempDir();
  mkdirSync(join(dir, "01-demo"), { recursive: true });
  writeFileSync(join(dir, "01-demo", "session.jsonl"), jsonl(rows));
  return dir;
}

const check = (rows: unknown[]) => transcriptLeakCheck(plant(rows), { vocabulary: NO_VOCAB });

describe("transcript leak check: clean input", () => {
  it("passes on scrubber output of varied synthetic rows", () => {
    const s = new TranscriptScrubber({ literals: { users: ["zorbo"], emails: [], accounts: [] } });
    const rows = [
      userRow("plain prompt " + "x ".repeat(100)),
      assistantRow({ type: "thinking", thinking: "secret", signature: "c2ln" }),
      assistantRow({ type: "tool_use", id: "toolu_01aaaaaaaaaaaaaaaa", name: "Bash", input: {} }),
      { type: "attachment", attachment: { type: "hook_success", hookName: "PreToolUse:Bash" } },
      {
        type: "user",
        cwd: "C:/Users/zorbo/projects/demo",
        message: { role: "user", content: "hi" },
      },
    ].map((r) => s.row(r));
    const r = check(rows);
    expect(r.byCategory).toEqual({});
    expect(r.rows).toBe(5);
  });

  it("reports file and row counts", () => {
    const r = check([userRow("hello")]);
    expect(r.files).toBe(1);
    expect(r.rows).toBe(1);
  });
});

describe("transcript leak check: each leak class on a planted line", () => {
  const cases: [string, unknown[], string][] = [
    ["windows path", [userRow("open C:/Users/bob/app/a.ts")], "transcript-home-path-shape"],
    ["escaped windows path", [userRow("open C:\\Users\\bob\\a.ts")], "transcript-home-path-shape"],
    ["msys path", [userRow("open /c/Users/bob/a.ts")], "transcript-home-path-shape"],
    ["linux home", [userRow("open /home/bob/a.ts")], "transcript-home-path-shape"],
    ["mac home", [userRow("open /Users/bob/a.ts")], "transcript-home-path-shape"],
    ["encoded folder", [userRow("in C--Users-bob-app")], "transcript-home-path-shape"],
    ["email", [userRow("mail bob@corp.example")], "transcript-email"],
    ["github token", [userRow("key ghp_0123456789abcdefABCDEF")], "transcript-token-prefix"],
    ["sk token", [userRow("key sk-abcdef0123456789abcdef")], "transcript-token-prefix"],
    ["bearer token", [userRow("Bearer abcDEF0123456789tok")], "transcript-token-prefix"],
    ["long token run", [userRow("k aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5")], "transcript-token-run"],
    ["free text over 120", [userRow("w ".repeat(100))], "transcript-free-text-over-120"],
    [
      "thinking text",
      [assistantRow({ type: "thinking", thinking: "private", signature: "<REDACTED-THINKING>" })],
      "transcript-thinking-not-redacted",
    ],
    [
      "signature",
      [assistantRow({ type: "thinking", thinking: "<REDACTED-THINKING>", signature: "c2ln" })],
      "transcript-signature-not-redacted",
    ],
    ["unknown key", [{ type: "user", surpriseKeyName: 1 }], "transcript-unknown-key"],
    [
      "unlisted hook name",
      [{ type: "attachment", attachment: { type: "hook_success", hookName: "acme-hook" } }],
      "transcript-string-not-allowlisted",
    ],
  ];

  it.each(cases)("flags %s", (_name, rows, category) => {
    const r = check(rows);
    expect(r.byCategory[category]).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/bob|ghp_|abcdef0123/);
  });

  it("accepts text of exactly 120 characters plus a truncation marker", () => {
    const r = check([userRow(`${"a ".repeat(60)}<TRUNCATED 400>`)]);
    expect(r.byCategory).toEqual({});
  });

  it("flags unparseable JSON", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "01-demo"));
    writeFileSync(join(dir, "01-demo", "session.jsonl"), "{not json\n");
    const r = transcriptLeakCheck(dir, { vocabulary: NO_VOCAB });
    expect(r.byCategory).toHaveProperty("transcript-unparseable-json");
  });

  it("flags a file type it does not know how to scan", () => {
    const dir = plant([userRow("hi")]);
    writeFileSync(join(dir, "01-demo", "notes.txt"), "x");
    const r = transcriptLeakCheck(dir, { vocabulary: NO_VOCAB });
    expect(r.byCategory).toHaveProperty("transcript-unscanned-file");
  });

  it("scans README.md text", () => {
    const dir = plant([userRow("hi")]);
    writeFileSync(join(dir, "01-demo", "README.md"), "see C:/Users/bob/x and bob@corp.example\n");
    const r = transcriptLeakCheck(dir, { vocabulary: NO_VOCAB });
    expect(r.byCategory["transcript-home-path-shape"]).toBe(1);
    expect(r.byCategory["transcript-email"]).toBe(1);
  });
});

describe("transcript leak check: account literals from raw", () => {
  /** Raw dir whose rows name an account; the checker derives its needles from it. */
  function rawWith(rows: unknown[]): string {
    const raw = makeTempDir();
    mkdirSync(join(raw, "01-demo"), { recursive: true });
    writeFileSync(join(raw, "01-demo", "session.jsonl"), jsonl(rows));
    return raw;
  }
  const rawRows = [
    {
      type: "attachment",
      cwd: "C:/Users/zorbo/projects/plumbus",
      attachment: { type: "x", context: { userEmail: "marigold.wexford42@corp.example" } },
    },
  ];

  it("flags a user name, an account-name fragment and an email local part", () => {
    const rawTranscripts = rawWith(rawRows);
    for (const text of ["hi zorbo here", "ask Marigold later", "the wexford desk"]) {
      const r = transcriptLeakCheck(plant([userRow(text)]), {
        rawTranscripts,
        vocabulary: NO_VOCAB,
      });
      expect(r.byCategory["transcript-account-name"], text).toBeGreaterThan(0);
      expect(r.literals.rawPresent).toBe(true);
      expect(r.literals.fragments).toBeGreaterThan(0);
    }
  });

  it("flags a raw folder name that is not public vocabulary", () => {
    const rawTranscripts = rawWith(rawRows);
    const r = transcriptLeakCheck(plant([userRow("work on plumbus today")]), {
      rawTranscripts,
      vocabulary: NO_VOCAB,
    });
    expect(r.byCategory["transcript-folder-name"]).toBeGreaterThan(0);
  });

  it("passes clean text with raw present and never returns a matched value", () => {
    const rawTranscripts = rawWith(rawRows);
    const r = transcriptLeakCheck(plant([userRow("nothing personal")]), {
      rawTranscripts,
      vocabulary: NO_VOCAB,
    });
    expect(r.byCategory).toEqual({});
    expect(JSON.stringify(r)).not.toMatch(/zorbo|marigold|wexford|plumbus/i);
  });
});
