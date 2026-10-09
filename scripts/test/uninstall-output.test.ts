import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, type TestContext } from "vitest";
import { copyCommands } from "../lib/uninstall-flow.mjs";
import { printable } from "../lib/printable.mjs";
import {
  cleanupTempDirs,
  KEEP_DEFAULT_OUT,
  loadJson,
  type LooseJson,
  makeTempDir,
  runInstallInProcess,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const STATE_NAME = "settings.json.sessiondeck-capture-state.json";
const ESC = "\u001b";
const NEL = "\u0085";
const install = (e: InstallEnv, args: string[] = [], extra: Record<string, string> = {}) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--apply", ...args], extra);
const uninstall = (e: InstallEnv, extra: Record<string, string> = {}) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--uninstall", "--apply"], extra);

function rewriteState(env: InstallEnv, change: (state: LooseJson) => object): void {
  const path = join(env.configDir, STATE_NAME);
  writeFileSync(path, JSON.stringify(change(loadJson(path))));
}

describe("printable (finding S8)", () => {
  it("replaces control characters and line separators, and keeps ordinary text", () => {
    expect(printable(`a${ESC}[2Jb\nc\r${NEL}d\u2028e`)).toBe("a?[2Jb?c??d?e");
    expect(printable("C:/Users/me/raw dir")).toBe("C:/Users/me/raw dir");
  });
});

describe("the next step after uninstall (finding R2)", () => {
  it("copyCommands copy the contents, create the target, and quote a single quote", () => {
    const lines = copyCommands("C:/it's/raw");
    expect(lines).toEqual([
      "PowerShell:",
      "  New-Item -ItemType Directory -Force '<checkout>/packages/contract/fixtures/raw'; " +
        "Copy-Item -Recurse -Force 'C:/it''s/raw/*' '<checkout>/packages/contract/fixtures/raw'",
      "bash:",
      "  mkdir -p '<checkout>/packages/contract/fixtures/raw' && " +
        "cp -R 'C:/it'\\''s/raw/.' '<checkout>/packages/contract/fixtures/raw/'",
    ]);
  });

  it("uninstall prints the check-ignore command and both copy commands for the raw path", async () => {
    const env = setupInstallEnv();
    const out = join(env.sandbox, "elsewhere").split("\\").join("/");
    await install(env, ["--out", out]);
    const r = await uninstall(env);
    expect(r.stdout).toContain("git check-ignore -v packages/contract/fixtures/raw/x");
    expect(r.stdout).toContain(`Copy-Item -Recurse -Force '${out}/*'`);
    expect(r.stdout).toContain(`cp -R '${out}/.'`);
    expect(r.stdout).toContain("mkdir -p '<checkout>/packages/contract/fixtures/raw'");
  });
});

describe("paths from the state file are not trusted for display (finding S8)", () => {
  it("an outDir that differs from the removed --out value is not printed", async () => {
    const env = setupInstallEnv();
    await install(env);
    rewriteState(env, (s) => ({ ...s, outDir: `C:/planted${ESC}[2J/copy-me` }));
    const r = await uninstall(env);
    expect(r.stdout).not.toContain("planted");
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout).toContain("does not match the --out value");
  });

  it("a deploy.dir with control characters is printed with them replaced", async () => {
    const env = setupInstallEnv();
    await install(env);
    const planted = join(env.sandbox, `evil${NEL}dir`);
    rewriteState(env, (s) => ({ ...s, deploy: { ...s.deploy, dir: planted } }));
    const r = await uninstall(env);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("evil?dir");
    expect(r.stdout).not.toContain(NEL);
  });
});

describe("a restored status line is called out (finding S7)", () => {
  it("prints which status line came back from the state file", async () => {
    const env = setupInstallEnv(false);
    writeFileSync(
      env.target,
      JSON.stringify({ statusLine: { type: "command", command: "echo mine" } }),
    );
    await install(env);
    const r = await uninstall(env);
    expect(r.stdout).toContain("Restored from the state file: statusLine.");
    expect(r.stdout).toContain("Check what it runs");
  });

  it("prints nothing about it when no status line was there before", async () => {
    const env = setupInstallEnv(false);
    await install(env);
    expect((await uninstall(env)).stdout).not.toContain("Restored from the state file");
  });
});

function link(ctx: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "junction");
    return true;
  } catch (error) {
    ctx.skip(`cannot create a junction or symlink here: ${String(error)}`);
    return false;
  }
}

describe("the deploy dir keeps raw even when the deploy home is a link (finding R3)", () => {
  it("says the directory is kept because it holds the raw captures", async (ctx) => {
    const env = setupInstallEnv(false);
    const real = join(makeTempDir(), "real-home");
    mkdirSync(real);
    const alias = join(env.sandbox, "alias-home");
    if (!link(ctx, real, alias)) return;
    const extra = { SESSIONDECK_CAPTURE_HOME: alias };
    const run = (args: string[]) =>
      runInstallInProcess(env.configDir, env.sandbox, [KEEP_DEFAULT_OUT, ...args], extra);
    expect((await run(["--apply"])).code).toBe(0);
    const r = await run(["--uninstall", "--apply"]);
    expect(r.stdout).toMatch(/Directory kept because it holds the raw captures/);
  });
});
