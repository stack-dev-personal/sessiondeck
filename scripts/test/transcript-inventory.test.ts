import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeCandidate,
  analyzeFile,
  formatStats,
  keyNames,
  safeEnum,
  selectCandidates,
  toolBucket,
  unknownKeys,
} from "../lib/transcript-inventory-core.mjs";
import { SCRIPTS_DIR, cleanupTempDirs, makeTempDir } from "./helpers";

afterEach(cleanupTempDirs);

const SCRIPT = join(SCRIPTS_DIR, "transcript-inventory.mjs");
const FAKE_EMAIL = "someone.private@example.invalid";
const FAKE_PATH = "C:\\Users\\fakeperson\\secret-project\\notes.txt";
const FAKE_TEXT = "the quick brown synthetic fox";
const FAKE_TOOL_ID = "toolu_FAKE123";

const base = { cwd: FAKE_PATH, sessionId: "sess-a", version: "2.1.300", uuid: "u" };

function rows(): unknown[] {
  return [
    { type: "last-prompt", lastPrompt: FAKE_EMAIL, leafUuid: "x", sessionId: "sess-a" },
    {
      ...base,
      type: "user",
      parentUuid: null,
      message: { role: "user", content: `<command-name>/clear</command-name> ${FAKE_TEXT}` },
    },
    {
      ...base,
      type: "assistant",
      parentUuid: "u",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-test-1",
        content: [
          { type: "thinking", thinking: FAKE_TEXT },
          { type: "tool_use", id: FAKE_TOOL_ID, name: "Bash", input: { command: FAKE_EMAIL } },
          { type: "tool_use", id: "t2", name: "mcp__srv__do", input: {} },
        ],
      },
    },
    {
      ...base,
      type: "assistant",
      parentUuid: "u",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: FAKE_TEXT }] },
    },
    {
      ...base,
      type: "user",
      parentUuid: null,
      sessionId: "other-session",
      toolUseResult: { stdout: FAKE_PATH, stderr: "", weirdKey: 1 },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: FAKE_TOOL_ID, content: FAKE_EMAIL }],
      },
    },
    { ...base, type: "system", subtype: "compact_boundary", logicalParentUuid: "u", isMeta: true },
    { ...base, type: "attachment", attachment: { type: "date", date: FAKE_TEXT } },
    { ...base, type: "user", isCompactSummary: true, message: { role: "user", content: "sum" } },
  ];
}

function writeJsonl(path: string, items: unknown[], extra = ""): void {
  writeFileSync(path, items.map((r) => JSON.stringify(r)).join("\n") + "\n" + extra);
}

function fixtureDir(): { dir: string; file: string } {
  const dir = makeTempDir();
  const file = join(dir, "sess-a.jsonl");
  writeJsonl(file, rows(), "not json\n");
  return { dir, file };
}

describe("transcript-inventory core", () => {
  it("counts row types, subtypes, attachment types, blocks and key sets", () => {
    const s = analyzeFile(fixtureDir().file);
    expect(s.rows).toBe(8);
    expect(s.bad).toBe(1);
    expect(s.byType.get("user")).toBe(3);
    expect(s.byType.get("last-prompt")).toBe(1);
    expect(s.systemSub.get("compact_boundary")).toBe(1);
    expect(s.attachType.get("date")).toBe(1);
    expect(s.blocks.get("assistant/tool_use")).toBe(2);
    expect(s.blocks.get("user/string")).toBe(2);
    expect(s.blocks.get("user/tool_result")).toBe(1);
    expect(s.toolResultShape.get("string")).toBe(1);
    expect(s.toolUse.get("Bash")).toBe(1);
    expect(s.toolUse.get("mcp")).toBe(1);
    expect(s.sidecar.get("Bash|stderr,stdout,weirdKey")).toBe(1);
    expect(s.models.get("claude-test-1")).toBe(1);
    expect(s.versions.get("2.1.300")).toBe(7);
    expect([...s.topKeySets.keys()]).toContain("last-prompt|lastPrompt,leafUuid,sessionId,type");
  });

  it("counts flags and slash commands", () => {
    const s = analyzeFile(fixtureDir().file);
    expect(s.flags.get("isCompactSummary")).toBe(1);
    expect(s.flags.get("isMeta")).toBe(1);
    expect(s.flags.get("logicalParentUuid")).toBe(1);
    expect(s.flags.get("compact_boundary")).toBe(1);
    expect(s.flags.get("repeated message.id")).toBe(1);
    expect(s.flags.get("parentUuid=null (non-first)")).toBe(1);
    expect(s.sessionIds.size).toBe(2);
    expect(s.commands.get("/clear")).toBe(1);
  });

  it("flags rows whose sessionId differs from the file name", () => {
    const s = analyzeFile(fixtureDir().file);
    expect(s.flags.get("sessionId!=filename")).toBe(1);
  });

  it("reports key names missing from fixture-keys.mjs", () => {
    const s = analyzeFile(fixtureDir().file);
    expect(unknownKeys(s)).toContain("weirdKey");
    expect(unknownKeys(s)).not.toContain("cwd");
  });

  it("never puts values into the formatted output", () => {
    const text = formatStats(analyzeFile(fixtureDir().file));
    for (const secret of [FAKE_EMAIL, FAKE_PATH, FAKE_TEXT, FAKE_TOOL_ID, "fakeperson", "msg_1"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("sanitises enums, keys and tool names", () => {
    expect(safeEnum(`has spaces ${FAKE_EMAIL}`)).toBe("<string>");
    expect(safeEnum(undefined)).toBe("<none>");
    expect(safeEnum("compact_boundary")).toBe("compact_boundary");
    expect(keyNames({ ok: 1, "/a/b c": 2, b: 3 })).toEqual(["<key>", "b", "ok"]);
    expect(keyNames("text")).toEqual([]);
    expect(toolBucket("mcp__x__y")).toBe("mcp");
    expect(toolBucket("Read")).toBe("Read");
    expect(toolBucket("my-private-tool")).toBe("other");
  });

  it("includes sub-agent files and their bytes", () => {
    const { dir, file } = fixtureDir();
    const sub = join(dir, "sess-a", "subagents");
    mkdirSync(sub, { recursive: true });
    writeJsonl(join(sub, "agent-1.jsonl"), [
      {
        ...base,
        type: "user",
        isSidechain: true,
        agentId: "a1",
        message: { role: "user", content: "x" },
      },
    ]);
    writeFileSync(join(sub, "agent-1.meta.json"), "{}");
    const c = analyzeCandidate(file);
    expect(c.subFiles).toEqual(["agent-1.jsonl"]);
    expect(c.metaFiles).toEqual(["agent-1.meta.json"]);
    expect(c.stats.subFiles).toBe(1);
    expect(c.stats.subBytes).toBeGreaterThan(0);
    expect(c.mainRows).toBe(8);
    expect(c.stats.rows).toBe(9);
    expect(c.stats.flags.get("isSidechain=true")).toBe(1);
  });

  it("selects the smaller of two equal-coverage candidates and satisfies required features", () => {
    const mk = (id: string, bytes: number, subs: number) => {
      const dir = makeTempDir();
      const f = join(dir, `${id}.jsonl`);
      writeJsonl(
        f,
        rows().map((r) => ({ ...(r as object), sessionId: id })),
      );
      if (subs > 0) {
        mkdirSync(join(dir, id, "subagents"), { recursive: true });
        writeJsonl(join(dir, id, "subagents", "agent-1.jsonl"), [rows()[1]]);
      }
      const c = analyzeCandidate(f);
      c.mainBytes = bytes;
      return c;
    };
    const cands = [mk("a", 900, 0), mk("b", 100, 0), mk("c", 500, 1)];
    const { chosen, notes } = selectCandidates(cands, 2);
    expect(chosen.map((c: { id: string }) => c.id).sort()).toEqual(["b", "c"]);
    expect(notes).toEqual([]);
  });
});

describe("transcript-inventory cli", () => {
  const run = (...a: string[]) =>
    execFileSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8", stdio: "pipe" });

  it("prints counts only, never ids or values", () => {
    const { dir } = fixtureDir();
    const out = run("--dir", dir, "--skip-recent-min", "-1");
    expect(out).toContain("candidates 1");
    for (const secret of [FAKE_EMAIL, FAKE_PATH, FAKE_TEXT, "fakeperson", "sess-a"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("skips recently modified files and excluded ids", () => {
    const { dir } = fixtureDir();
    expect(run("--dir", dir, "--skip-recent-min", "100000")).toContain("candidates 0");
    const ex = run("--dir", dir, "--skip-recent-min", "-1", "--exclude", "sess-a");
    expect(ex).toContain("candidates 0");
    expect(ex).toContain("excluded 1");
  });

  it("refuses to copy into a directory that git does not ignore", () => {
    const { dir } = fixtureDir();
    let code = 0;
    try {
      run("--dir", dir, "--skip-recent-min", "-1", "--copy-to", makeTempDir());
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(3);
  });
});
