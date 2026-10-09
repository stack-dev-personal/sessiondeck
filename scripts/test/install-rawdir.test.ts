import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultOutDir } from "../lib/out-dir-check.mjs";
import { resolveDeployDir } from "../lib/deploy.mjs";
import {
  cleanupTempDirs,
  isInside,
  KEEP_DEFAULT_OUT,
  loadJson,
  REPO_ROOT,
  runInstallInProcess,
  sandboxEnv,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const posix = (p: string) => p.split("\\").join("/");
const run = (e: InstallEnv, args: string[]) =>
  runInstallInProcess(e.configDir, e.sandbox, [KEEP_DEFAULT_OUT, ...args]);

describe("default raw directory", () => {
  it("is <deploy home>/raw, outside every work tree", () => {
    const env = setupInstallEnv();
    const e = sandboxEnv(env.sandbox, { SESSIONDECK_CAPTURE_HOME: env.deployDir });
    expect(defaultOutDir(e, env.sandbox)).toBe(join(env.deployDir, "raw"));
    const fromHome = defaultOutDir(sandboxEnv(env.sandbox), env.sandbox);
    expect(fromHome).toBe(join(resolveDeployDir(sandboxEnv(env.sandbox), env.sandbox), "raw"));
    expect(isInside(REPO_ROOT, fromHome)).toBe(false);
  });

  it("install prints it, registers it, and creates it", async () => {
    const env = setupInstallEnv();
    const preview = await run(env, []);
    expect(preview.stdout).toContain(`Raw capture directory: ${posix(join(env.deployDir, "raw"))}`);
    expect(existsSync(join(env.deployDir, "raw"))).toBe(false);
    const r = await run(env, ["--apply"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(env.deployDir, "raw", ".gitignore"))).toBe(true);
    const outArg = loadJson(env.target).hooks.Stop.at(-1).hooks[0].args.at(-1) as string;
    expect(outArg.endsWith("/deploy/raw")).toBe(true);
    expect(isInside(REPO_ROOT, outArg)).toBe(false);
  });
});

describe("uninstall and the raw directory", () => {
  it("never deletes raw, keeps the deploy dir, prints the recorded path and the next step", async () => {
    const env = setupInstallEnv();
    await run(env, ["--apply"]);
    const raw = join(env.deployDir, "raw");
    writeFileSync(join(raw, "keep.json"), "{}");
    const r = await run(env, ["--uninstall", "--apply"]);
    expect(r.code).toBe(0);
    expect(readdirSync(env.deployDir)).toEqual(["raw"]);
    expect(existsSync(join(raw, "keep.json"))).toBe(true);
    expect(r.stdout).toContain(`Raw captures were NOT deleted and stay in: ${posix(raw)}`);
    expect(r.stdout).toContain("copy that directory to packages/contract/fixtures/raw/");
    expect(r.stdout).toContain("p0/fixtures");
    expect(r.stdout).toMatch(/Directory kept because it holds the raw captures/);
  });

  it("prints the recorded --out directory too, and still removes an empty deploy dir", async () => {
    const env = setupInstallEnv();
    const out = join(env.sandbox, "elsewhere");
    await run(env, ["--apply", "--out", out]);
    const r = await run(env, ["--uninstall", "--apply"]);
    expect(r.stdout).toContain(`stay in: ${posix(out)}`);
    expect(existsSync(env.deployDir)).toBe(false);
  });
});
