import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_SECONDS } from "../lib/install-config.mjs";
import { commitSettings, SettingsChangedError } from "../lib/settings-files.mjs";
import { buildGroup } from "../lib/settings-model.mjs";
import { parseSidecar, SidecarError } from "../lib/sidecar.mjs";
import {
  cleanupTempDirs,
  loadJson,
  runInstallInProcess,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const SIDECAR = "settings.json.sessiondeck-capture-state.json";
const FAKE_TOKEN = "Bearer FAKE-TOKEN-NOT-A-SECRET-0123456789";
const run = (e: InstallEnv, args: string[]) => runInstallInProcess(e.configDir, e.sandbox, args);
const backups = (e: InstallEnv) => readdirSync(e.configDir).filter((n) => n.includes("backup"));

describe("sidecar is validated before it is trusted", () => {
  it.each([
    ["only a version", '{"version":1}'],
    ["not JSON", "{{{"],
    ["wrong version", '{"version":9}'],
  ])("%s: install and uninstall fail with a clear message", async (_name, text) => {
    const env = setupInstallEnv();
    writeFileSync(join(env.configDir, SIDECAR), text);
    const before = readFileSync(env.target);
    for (const args of [["--apply"], ["--uninstall", "--apply"]]) {
      const r = await run(env, args);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/capture state file is (malformed|not valid JSON)/);
      expect(r.stderr).not.toMatch(/unexpected error/);
    }
    expect(readFileSync(env.target).equals(before)).toBe(true);
  });

  const valid = {
    version: 2,
    previous: { statusLine: { present: false }, subagentStatusLine: { present: false } },
    createdEvents: [],
    createdHooksKey: false,
    createdFile: false,
  };

  it("rejects the old version 1 with an unsupported-version message", () => {
    expect(() => parseSidecar({ ...valid, version: 1 })).toThrow(/unsupported version 1/);
  });

  it("accepts a well-formed state", () => {
    expect(parseSidecar(valid).createdFile).toBe(false);
  });

  it.each([
    [
      "a previous value that is a capture entry",
      {
        previous: {
          ...valid.previous,
          statusLine: { present: true, value: { command: "node x --marker sessiondeck-capture" } },
        },
      },
    ],
    [
      "a previous value that is not an object",
      { previous: { ...valid.previous, statusLine: { present: true, value: "rm -rf" } } },
    ],
    ["an unknown event", { createdEvents: ["NotAnEvent"] }],
    [
      "a deploy file outside the allow list",
      { deploy: { dir: process.cwd(), files: [{ path: "../../victim", sha256: "a".repeat(64) }] } },
    ],
    ["a relative deploy dir", { deploy: { dir: "relative", files: [] } }],
    [
      "a bad hash",
      { deploy: { dir: process.cwd(), files: [{ path: "capture-fixtures.mjs", sha256: "xyz" }] } },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseSidecar({ ...valid, ...patch })).toThrow(SidecarError);
  });
});

describe("secrets on screen and at rest", () => {
  it("never prints a foreign status line, only its type and length", async () => {
    const env = setupInstallEnv();
    const settings = loadJson(env.target);
    const command = `curl -H "Authorization: ${FAKE_TOKEN}" https://example.invalid/status`;
    settings.statusLine = { type: "command", command };
    writeFileSync(env.target, JSON.stringify(settings, null, 2));
    const outputs: string[] = [];
    for (const args of [[], ["--apply"], ["--uninstall"], ["--uninstall", "--apply"]]) {
      const r = await run(env, args);
      outputs.push(r.stdout, r.stderr);
    }
    const all = outputs.join("\n");
    expect(all).not.toContain("FAKE-TOKEN");
    expect(all).not.toContain("example.invalid");
    expect(all).toContain(`type=command length=${command.length}`);
    expect(loadJson(env.target).statusLine.command).toBe(command);
  });

  it("uninstall names every backup and says they can hold tokens and how to delete them", async () => {
    const env = setupInstallEnv();
    await run(env, ["--apply"]);
    const r = await run(env, ["--uninstall", "--apply"]);
    const found = backups(env);
    expect(found).toHaveLength(2);
    for (const name of found) expect(r.stdout).toContain(name);
    expect(r.stdout).toMatch(/tokens from env/);
    expect(r.stdout).toMatch(/Delete them yourself/);
    expect(r.stdout).toContain(`State file removed: ${join(env.configDir, SIDECAR)}`);
  });

  it("makes at most one backup per run", async () => {
    const env = setupInstallEnv();
    await run(env, ["--apply"]);
    expect(backups(env)).toHaveLength(1);
    await run(env, ["--apply", "--out", join(env.sandbox, "raw-b")]);
    expect(backups(env)).toHaveLength(2);
    await run(env, ["--apply", "--out", join(env.sandbox, "raw-b")]);
    expect(backups(env)).toHaveLength(2);
  });
});

describe("settings changed while the installer ran", () => {
  it("aborts before the rename, keeps the other writer's edit, and rolls back the sidecar and backup", async () => {
    const env = setupInstallEnv();
    const parsed = readFileSync(env.target);
    writeFileSync(env.target, '{"model":"edited-by-someone-else"}\n');
    const edited = readFileSync(env.target);
    await expect(
      commitSettings({ target: env.target, original: parsed, next: "{}\n", state: { version: 2 } }),
    ).rejects.toThrow(SettingsChangedError);
    expect(readFileSync(env.target).equals(edited)).toBe(true);
    expect(existsSync(join(env.configDir, SIDECAR))).toBe(false);
    expect(backups(env)).toHaveLength(0);
    expect(readdirSync(env.configDir).some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("the backup holds the bytes that were parsed", async () => {
    const env = setupInstallEnv();
    const parsed = readFileSync(env.target);
    const backup = await commitSettings({
      target: env.target,
      original: parsed,
      next: "{}\n",
      state: undefined,
    });
    expect(readFileSync(backup!).equals(parsed)).toBe(true);
    expect(readFileSync(env.target, "utf8")).toBe("{}\n");
  });
});

describe("hook entries", () => {
  const ctx = { scriptPath: "C:/d/capture-fixtures.mjs", outDir: "C:/o" };

  it("SessionEnd has no timeout; every other event has the named one", () => {
    const sessionEnd = buildGroup(ctx, "SessionEnd").hooks as Record<string, unknown>[];
    expect("timeout" in sessionEnd[0]!).toBe(false);
    const stop = buildGroup(ctx, "Stop").hooks as Record<string, unknown>[];
    expect(stop[0]!.timeout).toBe(HOOK_TIMEOUT_SECONDS);
  });
});
