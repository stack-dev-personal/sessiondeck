import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import { foldPath, isOurHook, isOurStatus, findRemaining } from "../lib/settings-match.mjs";
import {
  cleanupTempDirs,
  INSTALL_SCRIPT,
  loadJson,
  makeTempDir,
  runInstall,
  runInstallInProcess,
  runScript,
  SCRIPTS_DIR,
  SETTINGS_FIXTURE,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const original = () => loadJson(SETTINGS_FIXTURE);
const install = (e: InstallEnv, extra: string[] = []) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--apply", ...extra]);
const uninstall = (e: InstallEnv, extra: string[] = []) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--uninstall", "--apply", ...extra]);
const sidecarFiles = (e: InstallEnv) =>
  readdirSync(e.configDir).filter((n) => n.includes("capture-state"));

describe("recognition does not depend on where the script lives", () => {
  it("uninstall from a copy of the scripts in another location (moved checkout)", async () => {
    const env = setupInstallEnv();
    await install(env);
    const moved = join(makeTempDir(), "other-checkout", "scripts");
    mkdirSync(moved, { recursive: true });
    cpSync(join(SCRIPTS_DIR, "lib"), join(moved, "lib"), { recursive: true });
    const { run } = (await import(pathToFileURL(join(moved, "lib", "install-cli.mjs")).href)) as {
      run: typeof import("../lib/install-cli.mjs").run;
    };
    const out: string[] = [];
    const code = await run({
      argv: ["--uninstall", "--apply"],
      env: {
        ...process.env,
        CLAUDECODE: "",
        CLAUDE_CONFIG_DIR: env.configDir,
        SESSIONDECK_CAPTURE_HOME: env.deployDir,
        HOME: env.sandbox,
        USERPROFILE: env.sandbox,
      },
      home: env.sandbox,
      print: (t) => out.push(t),
      printErr: (t) => out.push(t),
    });
    expect(code).toBe(0);
    expect(loadJson(env.target)).toEqual(original());
    expect(existsSync(env.deployDir)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "uninstall through a case-different path to the same checkout (Windows)",
    async () => {
      const env = setupInstallEnv();
      await runInstall(env.configDir, env.sandbox, ["--apply"]);
      const lower = INSTALL_SCRIPT.toLowerCase();
      expect(lower).not.toBe(INSTALL_SCRIPT);
      const r = await runScript(lower, ["--uninstall", "--apply"], {
        sandbox: env.sandbox,
        env: { CLAUDE_CONFIG_DIR: env.configDir, SESSIONDECK_CAPTURE_HOME: env.deployDir },
      });
      expect(r.code).toBe(0);
      expect(loadJson(env.target)).toEqual(original());
    },
  );

  it("matches entries recorded in the sidecar case-insensitively on Windows", () => {
    expect(foldPath("C:\\Users\\Me\\X.mjs", "win32")).toBe("c:/users/me/x.mjs");
    expect(foldPath("C:\\Users\\Me\\X.mjs", "linux")).toBe("C:/Users/Me/X.mjs");
    const hook = { command: "node", args: ["C:/Apps/Hook.MJS", "--flag"] };
    const record = { hook: { command: "node", args: ["c:/apps/hook.mjs", "--flag"] } };
    const full = { ...record, statusLine: "s", subagentStatusLine: "t" };
    expect(isOurHook(hook, full)).toBe(process.platform === "win32");
    expect(isOurStatus({ command: "x" }, "statusLine", undefined)).toBe(false);
  });

  it("recognises the pre-marker form by script name, wherever it sits", () => {
    const legacy = {
      type: "command",
      command: "node",
      args: ["D:/old/Scripts/Capture-Fixtures.mjs", "--out", "x"],
    };
    expect(isOurHook(legacy, undefined)).toBe(true);
    expect(isOurHook({ command: "node", args: ["D:/old/other.mjs"] }, undefined)).toBe(false);
    const status = {
      type: "command",
      command: 'node "D:/old/capture-fixtures.mjs" --statusline --out "o"',
    };
    expect(isOurStatus(status, "statusLine", undefined)).toBe(true);
  });

  it("findRemaining reports marker text in places stripping does not reach", () => {
    const odd = { hooks: { Stop: [{ hooks: { args: ["--marker", "sessiondeck-capture"] } }] } };
    expect(findRemaining(odd)).toEqual(["hooks.Stop"]);
    expect(findRemaining({ statusLine: { command: "echo hi" } })).toEqual([]);
  });
});

describe("fail closed", () => {
  it("keeps the sidecar and exits non-zero when nothing in the settings is recognised", async () => {
    const env = setupInstallEnv();
    await install(env);
    const edited = loadJson(env.target);
    for (const event of HOOK_EVENTS)
      edited.hooks[event] = [{ hooks: [{ command: "echo altered" }] }];
    edited.statusLine = { type: "command", command: "echo mine" };
    edited.subagentStatusLine = { type: "command", command: "echo mine too" };
    writeFileSync(env.target, JSON.stringify(edited, null, 2));
    const before = readFileSync(env.target);
    const r = await uninstall(env);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/state file was kept/);
    expect(sidecarFiles(env)).toHaveLength(1);
    expect(readFileSync(env.target).equals(before)).toBe(true);
    expect(existsSync(join(env.deployDir, "capture-fixtures.mjs"))).toBe(true);
  });

  it("works after the deployed copy was deleted", async () => {
    const env = setupInstallEnv();
    await install(env);
    rmSync(env.deployDir, { recursive: true, force: true });
    const r = await uninstall(env);
    expect(r.code).toBe(0);
    expect(loadJson(env.target)).toEqual(original());
    expect(sidecarFiles(env)).toHaveLength(0);
  });

  it("removes entries and restores nothing when the state file is gone", async () => {
    const env = setupInstallEnv(false);
    await install(env);
    rmSync(join(env.configDir, "settings.json.sessiondeck-capture-state.json"));
    const r = await uninstall(env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No state file was found/);
    const hooks = Object.values(loadJson(env.target).hooks as Record<string, unknown[]>);
    expect(hooks.every((groups) => groups.length === 0)).toBe(true);
    expect(loadJson(env.target).statusLine).toBeUndefined();
  });

  it("never records a capture status line as previous, in either format", async () => {
    const env = setupInstallEnv();
    const stale = loadJson(env.target);
    stale.statusLine = {
      type: "command",
      command: 'node "D:/gone/wt/S0/scripts/capture-fixtures.mjs" --statusline --out "D:/o"',
    };
    writeFileSync(env.target, JSON.stringify(stale, null, 2));
    expect((await install(env)).code).toBe(0);
    const edited = loadJson(env.target);
    expect(edited.statusLine.command).toContain("sessiondeck-capture");
    rmSync(join(env.configDir, "settings.json.sessiondeck-capture-state.json"));
    expect((await install(env, ["--out", join(env.sandbox, "raw2")])).code).toBe(0);
    expect((await uninstall(env)).code).toBe(0);
    expect(JSON.stringify(loadJson(env.target))).not.toMatch(
      /capture-fixtures|sessiondeck-capture/,
    );
    expect(loadJson(env.target).statusLine).toBeUndefined();
  });
});
