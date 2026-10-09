import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import {
  cleanupTempDirs,
  isInside,
  makeTempDir,
  runInstall,
  runInstallInProcess,
  runScript,
  INSTALL_SCRIPT,
  SETTINGS_FIXTURE,
  TARGET_PREFIX,
} from "./helpers";

afterAll(cleanupTempDirs);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Env {
  sandbox: string;
  configDir: string;
  target: string;
}

function setup(copyFixture = true): Env {
  const sandbox = makeTempDir();
  const configDir = join(sandbox, "config");
  mkdirSync(configDir);
  const target = join(configDir, "settings.json");
  if (copyFixture) copyFileSync(SETTINGS_FIXTURE, target);
  return { sandbox, configDir, target };
}

const load = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;
const original = (): Json => load(SETTINGS_FIXTURE);
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes("backup"));
const FAKE_ENV_VALUES = ["FAKE_ENV_VALUE_ALPHA_NOT_A_SECRET", "FAKE_ENV_VALUE_BETA_NOT_A_SECRET"];

describe("install", () => {
  it("prints a target inside the temp dir (guard against touching the real file)", async () => {
    const env = setup();
    const r = await runInstall(env.configDir, env.sandbox, ["--dry-run"]);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(TARGET_PREFIX));
    expect(line).toBeDefined();
    expect(isInside(env.sandbox, line!.slice(TARGET_PREFIX.length))).toBe(true);
  });

  it("adds our exec-form entry to all 17 events and keeps everything else", async () => {
    const env = setup();
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(r.code).toBe(0);
    const after = load(env.target);
    const before = original();

    for (const key of ["env", "permissions"]) expect(after[key]).toEqual(before[key]);
    const beforeKeys = Object.keys(before);
    expect(Object.keys(after).slice(0, beforeKeys.length)).toEqual(beforeKeys);
    expect(Object.keys(after).slice(beforeKeys.length)).toEqual(
      ["statusLine", "subagentStatusLine"].filter((k) => !beforeKeys.includes(k)),
    );
    const beforeEvents = Object.keys(before.hooks);
    expect(Object.keys(after.hooks).slice(0, beforeEvents.length)).toEqual(beforeEvents);
    expect(Object.keys(after.hooks).slice(beforeEvents.length)).toEqual(
      HOOK_EVENTS.filter((e) => !beforeEvents.includes(e)),
    );
    expect(Object.keys(after.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const event of HOOK_EVENTS) {
      const existing: unknown[] = before.hooks[event] ?? [];
      const groups: Json[] = after.hooks[event];
      expect(groups.slice(0, existing.length)).toEqual(existing);
      expect(groups).toHaveLength(existing.length + 1);
      const ours = groups[groups.length - 1]!;
      expect(ours.matcher).toBeUndefined();
      expect(ours.hooks).toHaveLength(1);
      const hook = ours.hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toBe("node");
      expect(Array.isArray(hook.args)).toBe(true);
      expect(hook.args[0]).toMatch(/capture-fixtures\.mjs$/);
      expect(hook.args.slice(1, 3)).toEqual(["--marker", "sessiondeck-capture"]);
      expect(hook.args[3]).toBe("--out");
      expect(hook.timeout).toBe(event === "SessionEnd" ? undefined : 5);
    }
    expect(readFileSync(env.target, "utf8").endsWith("}\n")).toBe(true);
    expect(after.statusLine.type).toBe("command");
    expect(after.statusLine.command).toMatch(
      /^node ".*capture-fixtures\.mjs" --marker sessiondeck-capture --statusline --out ".*"$/,
    );
    expect(after.subagentStatusLine.command).toMatch(/--subagents --out /);
    expect(after.subagentStatusLine.command).not.toContain("\\");
    expect(
      JSON.stringify([after.statusLine, after.subagentStatusLine, after.hooks.Stop.at(-1)]).replace(
        /\\"/g,
        "",
      ),
    ).not.toContain("\\");
  });

  it("makes a byte-identical backup and a sidecar", async () => {
    const env = setup();
    const originalBytes = readFileSync(env.target);
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    const found = backups(env.configDir);
    expect(found).toHaveLength(1);
    expect(readFileSync(join(env.configDir, found[0]!)).equals(originalBytes)).toBe(true);
    const sidecar = readdirSync(env.configDir).filter(
      (f) => f.includes("capture") && !f.includes("backup"),
    );
    expect(sidecar).toHaveLength(1);
  });

  it("is idempotent: a second install leaves the content unchanged", async () => {
    const env = setup();
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    const once = readFileSync(env.target, "utf8");
    const second = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(second.code).toBe(0);
    expect(readFileSync(env.target, "utf8")).toBe(once);
    expect(backups(env.configDir)).toHaveLength(1);
  });

  it("creates the file when missing, with only our keys", async () => {
    const env = setup(false);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(r.code).toBe(0);
    expect(Object.keys(load(env.target)).sort()).toEqual([
      "hooks",
      "statusLine",
      "subagentStatusLine",
    ]);
    expect(backups(env.configDir)).toHaveLength(0);
    const u = await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    expect(u.code).toBe(0);
    expect(existsSync(env.target)).toBe(false);
  });

  it("aborts on invalid JSON and leaves the file byte-identical", async () => {
    const env = setup(false);
    writeFileSync(env.target, '{"env": {"K": "v"},, }');
    const before = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/not valid JSON/);
    expect(readFileSync(env.target).equals(before)).toBe(true);
    expect(readdirSync(env.configDir)).toEqual(["settings.json"]);
  });

  it.each([
    ["hooks is an array", { hooks: [] }],
    ["hooks is a string", { hooks: "x" }],
    ["an event value is an object", { hooks: { Stop: {} } }],
    ["the root is an array", []],
  ])("aborts when %s", async (_name, content) => {
    const env = setup(false);
    writeFileSync(env.target, JSON.stringify(content));
    const before = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(r.code).not.toBe(0);
    expect(readFileSync(env.target).equals(before)).toBe(true);
    expect(readdirSync(env.configDir)).toEqual(["settings.json"]);
  });

  it("--dry-run writes nothing but prints the diff", async () => {
    const env = setup();
    const before = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(readFileSync(env.target).equals(before)).toBe(true);
    expect(readdirSync(env.configDir)).toEqual(["settings.json"]);
    expect(r.stdout).toMatch(/^\+ hooks\.SessionStart: /m);
    expect(r.stdout).toMatch(/^- statusLine: /m);
    expect(r.stdout).toMatch(/^\+ statusLine: /m);
  });

  it("never prints unrelated keys such as env values", async () => {
    const env = setup();
    for (const args of [["--dry-run"], ["--apply"], ["--uninstall", "--apply"]]) {
      const r = await runInstallInProcess(env.configDir, env.sandbox, args);
      for (const secret of FAKE_ENV_VALUES) {
        expect(r.stdout + r.stderr).not.toContain(secret);
      }
    }
  });

  it("states that the status line is replaced and restored by --uninstall", async () => {
    const env = setup();
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(r.stdout).toMatch(/status line is replaced/i);
    expect(r.stdout).toContain("--uninstall");
  });

  it("rejects an --out path with shell metacharacters", async () => {
    const env = setup();
    const before = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, [
      "--apply",
      "--out",
      join(env.sandbox, 'a"b$c'),
    ]);
    expect(r.code).not.toBe(0);
    expect(readFileSync(env.target).equals(before)).toBe(true);
  });

  it("rejects unknown flags", async () => {
    const env = setup();
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--dry-run");
  });
});

describe("uninstall", () => {
  it("returns a file deep-equal to the original", async () => {
    const env = setup();
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    expect(r.code).toBe(0);
    expect(load(env.target)).toEqual(original());
    expect(JSON.stringify(load(env.target))).toBe(JSON.stringify(original()));
    expect(backups(env.configDir).length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(env.configDir).some((f) => f.includes("capture-state"))).toBe(false);
  });

  it("keeps changes the user made after install", async () => {
    const env = setup();
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    const edited = load(env.target);
    edited.model = "opus";
    edited.hooks.Stop = [
      ...edited.hooks.Stop,
      { hooks: [{ type: "command", command: "bash <HOME>/late-hook.sh" }] },
    ];
    edited.hooks.Notification = [
      { hooks: [{ type: "command", command: "bash <HOME>/notify.sh" }] },
      ...edited.hooks.Notification,
    ];
    writeFileSync(env.target, JSON.stringify(edited, null, 2));
    await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    const after = load(env.target);
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toEqual([
      ...original().hooks.Stop,
      { hooks: [{ type: "command", command: "bash <HOME>/late-hook.sh" }] },
    ]);
    expect(after.hooks.Notification).toEqual([
      { hooks: [{ type: "command", command: "bash <HOME>/notify.sh" }] },
    ]);
    expect(after.statusLine).toEqual(original().statusLine);
    expect(after.subagentStatusLine).toBeUndefined();
    expect(after.hooks.SessionStart).toBeUndefined();
  });

  it("does not restore statusLine when the user replaced it since install", async () => {
    const env = setup();
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    const edited = load(env.target);
    edited.statusLine = { type: "command", command: "echo mine" };
    writeFileSync(env.target, JSON.stringify(edited, null, 2));
    await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    expect(load(env.target).statusLine).toEqual({ type: "command", command: "echo mine" });
  });

  it("is a clean no-op without a prior install", async () => {
    const env = setup();
    const before = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    expect(r.code).toBe(0);
    expect(readFileSync(env.target).equals(before)).toBe(true);
    expect(readdirSync(env.configDir)).toEqual(["settings.json"]);
    const none = setup(false);
    expect(
      (await runInstallInProcess(none.configDir, none.sandbox, ["--uninstall", "--apply"])).code,
    ).toBe(0);
  });

  it("reinstall after the user changed statusLine records the new previous value", async () => {
    const env = setup();
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    const edited = load(env.target);
    edited.statusLine = { type: "command", command: "echo mine" };
    writeFileSync(env.target, JSON.stringify(edited, null, 2));
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    expect(load(env.target).statusLine).toEqual({ type: "command", command: "echo mine" });
  });
});

describe("end to end (spawned)", () => {
  it("--apply then --uninstall --apply through the real entry point", async () => {
    const env = setup();
    const installed = await runInstall(env.configDir, env.sandbox, ["--apply"]);
    expect(installed.code).toBe(0);
    expect(Object.keys(load(env.target).hooks)).toEqual(expect.arrayContaining([...HOOK_EVENTS]));
    const removed = await runInstall(env.configDir, env.sandbox, ["--uninstall", "--apply"]);
    expect(removed.code).toBe(0);
    expect(JSON.stringify(load(env.target))).toBe(JSON.stringify(original()));
    expect(removed.stdout).toContain("Raw captures were NOT deleted");
  });
});

describe("environment safety", () => {
  it("honours CLAUDE_CONFIG_DIR, not the home directory", async () => {
    const env = setup();
    const r = await runScript(INSTALL_SCRIPT, ["--dry-run", "--out", join(env.sandbox, "raw")], {
      sandbox: env.sandbox,
      env: { CLAUDE_CONFIG_DIR: env.configDir },
    });
    expect(r.stdout).toContain(`${TARGET_PREFIX}${env.target}`);
  });
});
