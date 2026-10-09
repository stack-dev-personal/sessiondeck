import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkOutDir, defaultOutDir, fixturesRoot } from "../lib/out-dir-check.mjs";
import { isDefaultTarget } from "../lib/settings-files.mjs";
import {
  cleanupTempDirs,
  INSTALL_SCRIPT,
  listTree,
  makeTempDir,
  REPO_ROOT,
  runInstallInProcess,
  runScript,
  sandboxEnv,
  setupInstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("git", args, { cwd, env, windowsHide: true, encoding: "utf8" });
}
const gitAvailable = git(REPO_ROOT, ["--version"]).status === 0;
const inRepo = gitAvailable && git(REPO_ROOT, ["rev-parse", "--is-inside-work-tree"]).status === 0;

describe("interlock", () => {
  it("no flags: previews and creates or changes nothing anywhere", async () => {
    const env = setupInstallEnv();
    const before = listTree(env.sandbox);
    const bytes = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Dry run: nothing was written/);
    expect(listTree(env.sandbox)).toEqual(before);
    expect(readFileSync(env.target).equals(bytes)).toBe(true);
    const u = await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall"]);
    expect(u.code).toBe(0);
    expect(listTree(env.sandbox)).toEqual(before);
  });

  it.each([[[]], [["--apply"]], [["--uninstall"]], [["--uninstall", "--apply"]]])(
    "CLAUDECODE with the default target refuses before reading it (%j)",
    async (flags) => {
      const sandbox = makeTempDir();
      // The default target inside the sandbox holds invalid JSON: reading it would print an error.
      mkdirSync(join(sandbox, ".claude"));
      writeFileSync(join(sandbox, ".claude", "settings.json"), "{ not json");
      const before = listTree(sandbox);
      const r = await runScript(INSTALL_SCRIPT, flags, {
        sandbox,
        env: {
          CLAUDECODE: "1",
          SESSIONDECK_CAPTURE_HOME: join(sandbox, "deploy"),
        },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/plain terminal/);
      expect(r.stdout + r.stderr).not.toMatch(/Target settings file|not valid JSON/);
      expect(listTree(sandbox)).toEqual(before);
      expect(readFileSync(join(sandbox, ".claude", "settings.json"), "utf8")).toBe("{ not json");
    },
  );

  it("CLAUDECODE with an explicit config dir elsewhere is allowed", async () => {
    const env = setupInstallEnv();
    const r = await runInstallInProcess(env.configDir, env.sandbox, [], { CLAUDECODE: "1" });
    expect(r.code).toBe(0);
  });

  it("isDefaultTarget sees through an explicit CLAUDE_CONFIG_DIR that equals the default", () => {
    const home = makeTempDir();
    expect(isDefaultTarget({}, home)).toBe(true);
    expect(isDefaultTarget({ CLAUDE_CONFIG_DIR: join(home, ".claude") }, home)).toBe(true);
    expect(isDefaultTarget({ CLAUDE_CONFIG_DIR: join(home, "other") }, home)).toBe(false);
  });

  it("--apply together with --dry-run is a usage error", async () => {
    const env = setupInstallEnv();
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply", "--dry-run"]);
    expect(r.code).toBe(2);
  });

  it("--out without a value is a usage error and writes nothing", async () => {
    const env = setupInstallEnv();
    const before = listTree(env.sandbox);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply", "--out"]);
    expect(r.code).toBe(2);
    expect(listTree(env.sandbox)).toEqual(before);
  });
});

describe("capture directory", () => {
  it("gets a .gitignore of * when the installer creates it", async () => {
    const env = setupInstallEnv();
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(readFileSync(join(env.sandbox, "raw", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("gets a .gitignore of * when the hook creates it", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "hook-made");
    await runScript(join(INSTALL_SCRIPT, "..", "capture-fixtures.mjs"), ["--out", out], {
      sandbox,
      input: '{"hook_event_name":"Stop"}',
    });
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toBe("*\n");
  });

  it.each(["", "Stop", "settings", "raw/../Stop"])(
    "refuses fixtures/%s, which would mix raw files into the committed layout",
    async (sub) => {
      const dir = join(fixturesRoot(), sub);
      await expect(checkOutDir(dir, sandboxEnv(makeTempDir()))).rejects.toThrow(
        /committed fixtures/,
      );
    },
  );

  it("refuses a directory that contains the fixtures root", async () => {
    const env = sandboxEnv(makeTempDir());
    await expect(checkOutDir(join(fixturesRoot(), ".."), env)).rejects.toThrow(
      /committed fixtures/,
    );
  });

  it("the installer exits non-zero for --out equal to the fixtures root", async () => {
    const env = setupInstallEnv();
    const before = listTree(env.sandbox);
    const r = await runInstallInProcess(env.configDir, env.sandbox, [
      "--apply",
      "--out",
      fixturesRoot(),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/committed fixtures/);
    expect(listTree(env.sandbox)).toEqual(before);
  });

  it.skipIf(!inRepo)(
    "accepts the default fixtures/raw (ignored) and tracks nothing under it",
    async () => {
      await expect(
        checkOutDir(defaultOutDir(), sandboxEnv(makeTempDir())),
      ).resolves.toBeUndefined();
      expect(git(REPO_ROOT, ["ls-files", "packages/contract/fixtures/raw"]).stdout.trim()).toBe("");
    },
  );

  it.skipIf(!gitAvailable)("inside a git work tree: refused until git ignores it", async () => {
    const env = setupInstallEnv();
    const repo = join(env.sandbox, "repo");
    mkdirSync(repo);
    const gitEnv = sandboxEnv(env.sandbox);
    expect(git(repo, ["init", "-q"], gitEnv).status).toBe(0);
    const out = join(repo, "raw");
    const args = ["--apply", "--out", out];
    const refused = await runInstallInProcess(env.configDir, env.sandbox, args);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/not ignored by git/);
    expect(existsSync(out)).toBe(false);
    writeFileSync(join(repo, ".gitignore"), "raw/\n");
    const accepted = await runInstallInProcess(env.configDir, env.sandbox, args);
    expect(accepted.code).toBe(0);
    expect(existsSync(join(out, ".gitignore"))).toBe(true);
  });
});

describe("settings file protections", () => {
  it("refuses a symlinked settings.json and leaves the link and its target alone", async (ctx) => {
    const env = setupInstallEnv(false);
    const real = join(env.sandbox, "real-settings.json");
    writeFileSync(real, "{}\n");
    try {
      symlinkSync(real, env.target, "file");
    } catch {
      ctx.skip("cannot create a file symlink on this platform (needs privilege on Windows)");
      return;
    }
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/symbolic link/);
    expect(readFileSync(real, "utf8")).toBe("{}\n");
    expect(lstatSync(env.target).isSymbolicLink()).toBe(true);
  });

  it("sweeps stale installer temp files only", async () => {
    const env = setupInstallEnv();
    const stale = join(env.configDir, "settings.json.tmp-0123456789ab");
    const fresh = join(env.configDir, "settings.json.tmp-ba9876543210");
    const foreign = join(env.configDir, "settings.json.tmp.1234");
    for (const p of [stale, fresh, foreign]) writeFileSync(p, "x");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(foreign, old, old);
    await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});
