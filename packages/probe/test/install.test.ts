import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeRoot } from "./helpers.ts";
import {
  type Doc,
  harnessFixture,
  readJson,
  readText,
  runCli,
  sandbox,
  writeText,
} from "./fixtures/sandbox.ts";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];
const distDir = join(probeRoot, "dist").replace(/\\/g, "/");

const isOurs = (h: Doc): boolean =>
  Array.isArray(h?.args) && h.args.includes("--sessiondeck-probe");

describe("probe install (R1.8)", () => {
  it("leaves every pre-existing group, matcher, statusLine, permissions and env untouched", async () => {
    const sb = sandbox(harnessFixture);
    const before = readJson(sb.settings);
    const r = await runCli(["install"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    const after = readJson(sb.settings);

    expect(after.permissions).toEqual(before.permissions);
    expect(after.env).toEqual(before.env);
    expect(after.statusLine).toEqual(before.statusLine);
    // Key order of untouched top-level keys is preserved.
    expect(Object.keys(after).slice(0, 4)).toEqual(Object.keys(before));
    for (const [event, groups] of Object.entries<Doc[]>(before.hooks)) {
      const kept = after.hooks[event].filter((g: Doc) => !g.hooks.some(isOurs));
      expect(kept).toEqual(groups);
      // Ours comes after the existing groups, never before.
      expect(after.hooks[event].slice(0, groups.length)).toEqual(groups);
    }
  });

  it("registers 17 exec-form hooks with forward-slash paths and a 5 s timeout", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(["install"], sb.env);
    const after = readJson(sb.settings);
    expect(
      Object.keys(after.hooks).filter((e) => !(e in readJson(harnessFixture).hooks)),
    ).toHaveLength(13);
    for (const event of EVENTS) {
      const ours = after.hooks[event].flatMap((g: Doc) => g.hooks).filter(isOurs);
      expect(ours).toHaveLength(1);
      expect(ours[0]).toEqual({
        type: "command",
        command: "node",
        args: [`${distDir}/hook.mjs`, "--sessiondeck-probe"],
        timeout: 5,
      });
    }
    expect(readText(sb.settings)).not.toContain("\\\\");
  });

  it("is idempotent: a second and third run leave a byte-identical file and no new backup", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(["install"], sb.env);
    const once = readText(sb.settings);
    const backups = readdirSync(sb.home).filter((f) => f.startsWith("settings.backup-")).length;
    await runCli(["install"], sb.env);
    await runCli(["install"], sb.env);
    expect(readText(sb.settings)).toBe(once);
    expect(readdirSync(sb.home).filter((f) => f.startsWith("settings.backup-"))).toHaveLength(
      backups,
    );
  });

  it("keeps our position when another tool adds a group after ours, and does not duplicate", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(["install"], sb.env);
    const s = readJson(sb.settings);
    s.hooks.Stop.push({ hooks: [{ type: "command", command: "later" }] });
    writeText(sb.settings, `${JSON.stringify(s, null, 2)}\n`);
    const mid = readText(sb.settings);
    await runCli(["install"], sb.env);
    expect(readText(sb.settings)).toBe(mid);
  });

  it("uninstall restores the fixture (JSON-deep-equal)", async () => {
    const sb = sandbox(harnessFixture);
    const original = readText(sb.settings);
    await runCli(["install"], sb.env);
    await runCli(["uninstall"], sb.env);
    expect(readJson(sb.settings)).toEqual(JSON.parse(original));
  });

  it("uninstall restores a 2-space file byte for byte", async () => {
    const sb = sandbox(harnessFixture, true);
    const original = readText(sb.settings);
    await runCli(["install"], sb.env);
    expect(readText(sb.settings)).not.toBe(original);
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(readText(sb.settings)).toBe(original);
    expect(readJson(sb.settings)).toEqual(JSON.parse(original));
  });

  it("uninstall without install state still removes only marked entries", async () => {
    const sb = sandbox(harnessFixture);
    const original = readText(sb.settings);
    await runCli(["install"], sb.env);
    writeFileSync(join(sb.home, "install-state.json"), "garbage");
    await runCli(["uninstall"], sb.env);
    expect(readJson(sb.settings)).toEqual(JSON.parse(original));
  });

  it("a different statusLine is left alone with a notice", async () => {
    const sb = sandbox(harnessFixture);
    const before = readJson(sb.settings).statusLine;
    const r = await runCli(["install"], sb.env);
    expect(r.stdout).toMatch(/notice: statusLine: you already have one/);
    expect(readJson(sb.settings).statusLine).toEqual(before);
    // The subagent status line was absent, so ours is set.
    expect(readJson(sb.settings).subagentStatusLine.command).toMatch(
      /^node .*subagents\.mjs --sessiondeck-probe$/,
    );
  });

  it("--statusline=replace takes over and uninstall restores the previous value exactly", async () => {
    const sb = sandbox(harnessFixture, true);
    const original = readText(sb.settings);
    const before = readJson(sb.settings).statusLine;
    const r = await runCli(["install", "--statusline=replace"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    const sl = readJson(sb.settings).statusLine;
    expect(sl.command).toBe(`node ${distDir}/statusline.mjs --sessiondeck-probe`);
    expect(sl.command).not.toContain("\\");
    // Re-running install must not record our own entry as the "previous" one.
    await runCli(["install", "--statusline=replace"], sb.env);
    await runCli(["uninstall"], sb.env);
    expect(readJson(sb.settings).statusLine).toEqual(before);
    expect(readText(sb.settings)).toBe(original);
  });

  it("malformed settings are refused, exit non-zero, nothing changes", async () => {
    const sb = sandbox();
    writeText(sb.settings, '{ "hooks": { oops');
    const r = await runCli(["install", "--hub", "http://127.0.0.1:1"], sb.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not valid JSON/);
    expect(readText(sb.settings)).toBe('{ "hooks": { oops');
    expect(existsSync(sb.home)).toBe(false);
    const u = await runCli(["uninstall"], sb.env);
    expect(u.code).toBe(1);
    expect(readText(sb.settings)).toBe('{ "hooks": { oops');
  });

  it("refuses a structurally wrong hooks entry without changing the file", async () => {
    const sb = sandbox();
    writeText(sb.settings, '{"hooks":{"Stop":"nope"}}');
    const r = await runCli(["install"], sb.env);
    expect(r.code).toBe(1);
    expect(readText(sb.settings)).toBe('{"hooks":{"Stop":"nope"}}');
  });

  it("creates the settings file when absent, and uninstall removes the file it created", async () => {
    const sb = sandbox();
    expect(existsSync(sb.settings)).toBe(false);
    const r = await runCli(["install"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    const s = readJson(sb.settings);
    expect(Object.keys(s.hooks)).toEqual(EVENTS);
    await runCli(["uninstall"], sb.env);
    expect(existsSync(sb.settings)).toBe(false);
  });

  it("preserves a compact file's indent and a missing trailing newline", async () => {
    const sb = sandbox();
    const compact = '{\n    "model": "x"\n}';
    writeText(sb.settings, compact);
    await runCli(["install"], sb.env);
    const text = readText(sb.settings);
    expect(text.startsWith('{\n    "model": "x",\n    "hooks"')).toBe(true);
    expect(text.endsWith("\n")).toBe(false);
    await runCli(["uninstall"], sb.env);
    expect(readText(sb.settings)).toBe(compact);
  });

  it("backs up the original before the first write", async () => {
    const sb = sandbox(harnessFixture);
    const original = readText(sb.settings);
    await runCli(["install"], sb.env);
    const backups = readdirSync(sb.home).filter((f) => /^settings\.backup-.*\.json$/.test(f));
    expect(backups).toHaveLength(1);
    expect(readText(join(sb.home, backups[0] as string))).toBe(original);
  });

  it("--settings overrides CLAUDE_CONFIG_DIR", async () => {
    const sb = sandbox();
    const other = join(sb.root, "other.json");
    writeText(other, "{}\n");
    await runCli(["install", "--settings", other], sb.env);
    expect(Object.keys(readJson(other).hooks)).toHaveLength(17);
    expect(existsSync(sb.settings)).toBe(false);
  });

  it("statusLine path with spaces is quoted", async () => {
    const { buildCtx } = await import("../src/install/run.ts");
    const c = buildCtx("/tmp/with space/dist");
    expect(c.statuslineCommand).toBe(
      'node "/tmp/with space/dist/statusline.mjs" --sessiondeck-probe',
    );
    expect(() => buildCtx('/tmp/we"ird')).toThrow(/unsafe/);
  });
});
