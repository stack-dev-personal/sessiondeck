import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, type TestContext } from "vitest";
import { UNINSTALL_NOTE_NAME } from "../lib/install-config.mjs";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import { isDefaultTarget } from "../lib/settings-files.mjs";
import {
  cleanupTempDirs,
  loadJson,
  makeTempDir,
  runInstallInProcess,
  SCRIPTS_DIR,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const isWindows = process.platform === "win32";
const install = (e: InstallEnv, home?: string) =>
  runInstallInProcess(
    e.configDir,
    e.sandbox,
    ["--apply"],
    home ? { SESSIONDECK_CAPTURE_HOME: home } : {},
  );
const uninstall = (e: InstallEnv) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--uninstall", "--apply"]);

/** Directory link: a junction on Windows (needs no privilege), a symlink elsewhere. */
function link(ctx: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "junction");
    return true;
  } catch (error) {
    ctx.skip(`cannot create a junction or symlink here: ${String(error)}`);
    return false;
  }
}

describe("interlock compares real paths (finding 3)", () => {
  it("a junction or symlink to the default config dir is still the default", async (ctx) => {
    const sandbox = makeTempDir();
    mkdirSync(join(sandbox, ".claude"));
    writeFileSync(join(sandbox, ".claude", "settings.json"), "{ not json");
    if (!link(ctx, join(sandbox, ".claude"), join(sandbox, "alias"))) return;
    const env = { CLAUDE_CONFIG_DIR: join(sandbox, "alias") };
    expect(await isDefaultTarget(env, sandbox, sandbox)).toBe(true);
    const r = await runInstallInProcess(join(sandbox, "alias"), sandbox, ["--apply"], {
      CLAUDECODE: "1",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Refusing to touch the real Claude settings/);
    expect(readFileSync(join(sandbox, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  it.skipIf(!isWindows)(
    "an extended-length prefix does not hide the default dir (Windows only: the prefix is a Windows form)",
    async () => {
      const sandbox = makeTempDir();
      mkdirSync(join(sandbox, ".claude"));
      const prefixed = `\\\\?\\${join(sandbox, ".claude")}`;
      expect(await isDefaultTarget({ CLAUDE_CONFIG_DIR: prefixed }, sandbox, sandbox)).toBe(true);
    },
  );

  it("changing the home variable does not hide the account's own default dir", async () => {
    const realHome = makeTempDir();
    const fakeHome = makeTempDir();
    mkdirSync(join(realHome, ".claude"));
    const env = { CLAUDE_CONFIG_DIR: join(realHome, ".claude") };
    expect(await isDefaultTarget(env, fakeHome, realHome)).toBe(true);
    expect(await isDefaultTarget(env, fakeHome, fakeHome)).toBe(false);
  });
});

describe("the deployed copy: moves, planted links, and the uninstall note", () => {
  it("a changed deploy dir removes the copy the first install left behind (finding 4)", async () => {
    const env = setupInstallEnv(false);
    const first = join(env.sandbox, "first-copy");
    const second = join(env.sandbox, "second-copy");
    expect((await install(env, first)).code).toBe(0);
    expect(existsSync(join(first, "capture-fixtures.mjs"))).toBe(true);
    const r = await install(env, second);
    expect(r.code).toBe(0);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(join(second, "capture-fixtures.mjs"))).toBe(true);
    expect(r.stdout).toContain("Previous deployed copy");
  });

  it("a link planted at <deploy>/lib cannot redirect install (finding 5)", async (ctx) => {
    const env = setupInstallEnv(false);
    const elsewhere = makeTempDir();
    mkdirSync(env.deployDir, { recursive: true });
    writeFileSync(join(elsewhere, "capture-core.mjs"), "// not ours\n");
    if (!link(ctx, elsewhere, join(env.deployDir, "lib"))) return;
    const r = await install(env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/escaped/);
    expect(readdirSync(elsewhere)).toEqual(["capture-core.mjs"]);
    expect(readFileSync(join(elsewhere, "capture-core.mjs"), "utf8")).toBe("// not ours\n");
    expect(existsSync(join(env.configDir, "settings.json"))).toBe(false);
  });

  it("a link swapped in at <deploy>/lib after install keeps uninstall away from it (finding 5)", async (ctx) => {
    const env = setupInstallEnv(false);
    await install(env);
    const elsewhere = join(makeTempDir(), "lib");
    mkdirSync(elsewhere);
    for (const name of readdirSync(join(env.deployDir, "lib"))) {
      writeFileSync(join(elsewhere, name), readFileSync(join(env.deployDir, "lib", name)));
    }
    const planted = join(env.sandbox, "lib-moved-aside");
    mkdirSync(planted);
    const { renameSync } = await import("node:fs");
    renameSync(join(env.deployDir, "lib"), join(planted, "lib"));
    if (!link(ctx, elsewhere, join(env.deployDir, "lib"))) return;
    await uninstall(env);
    expect(readdirSync(elsewhere).length).toBeGreaterThan(0);
  });

  it("deploys an UNINSTALL.txt that lists the manual steps (finding 10)", async () => {
    const env = setupInstallEnv(true);
    await install(env);
    const note = join(env.deployDir, UNINSTALL_NOTE_NAME);
    const text = readFileSync(note, "utf8");
    expect(text).toContain("--marker");
    expect(text).toContain("sessiondeck-capture");
    expect(text).toContain("settings.json.sessiondeck-capture-state.json");
    expect(text).toContain("settings.json.sessiondeck-backup-");
    for (const event of HOOK_EVENTS) expect(text).toContain(event);
    expect(
      loadJson(
        join(env.configDir, "settings.json.sessiondeck-capture-state.json"),
      ).deploy.files.map((f: { path: string }) => f.path),
    ).toContain(UNINSTALL_NOTE_NAME);
    await uninstall(env);
    expect(existsSync(env.deployDir)).toBe(false);
  });

  it("the README carries the same manual removal text (finding 10)", () => {
    const readme = readFileSync(join(SCRIPTS_DIR, "README.md"), "utf8");
    const note = readFileSync(join(SCRIPTS_DIR, UNINSTALL_NOTE_NAME), "utf8");
    expect(readme).toContain(note.trim());
  });
});

describe.skipIf(isWindows)(
  "POSIX file modes (finding 9; Windows uses inherited ACLs, not modes)",
  () => {
    const MODE_MASK = 0o777;
    const modeOf = (path: string) => statSync(path).mode & MODE_MASK;

    it("keeps the settings mode and makes backups and the state file owner-only", async () => {
      const env = setupInstallEnv(true);
      const { chmodSync } = await import("node:fs");
      chmodSync(env.target, 0o640);
      await install(env);
      expect(modeOf(env.target)).toBe(0o640);
      const names = readdirSync(env.configDir);
      const backup = names.find((n) => n.includes("backup"));
      const state = names.find((n) => n.endsWith("capture-state.json"));
      expect(modeOf(join(env.configDir, backup!))).toBe(0o600);
      expect(modeOf(join(env.configDir, state!))).toBe(0o600);
      await uninstall(env);
      expect(modeOf(env.target)).toBe(0o640);
    });

    it("a 0600 settings file stays 0600", async () => {
      const env = setupInstallEnv(true);
      const { chmodSync } = await import("node:fs");
      chmodSync(env.target, 0o600);
      await install(env);
      expect(modeOf(env.target)).toBe(0o600);
    });
  },
);
