import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, runInstallInProcess, setupInstallEnv } from "./helpers";

const hooks = vi.hoisted(() => ({ beforeCommit: undefined as (() => void) | undefined }));

// Lets a test change the settings file after the installer read it and before it re-checks the
// bytes, which is the "changed while running" abort.
vi.mock("../lib/settings-files.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/settings-files.mjs")>();
  return {
    ...real,
    commitSettings: (args: Parameters<typeof real.commitSettings>[0]) => {
      hooks.beforeCommit?.();
      return real.commitSettings(args);
    },
  };
});

afterAll(() => {
  hooks.beforeCommit = undefined;
  cleanupTempDirs();
});

describe("an aborted install leaves nothing behind (finding 4)", () => {
  it("first install, settings changed on disk: no deployed files, no state file, no backup", async () => {
    const env = setupInstallEnv(true);
    hooks.beforeCommit = () => appendFileSync(env.target, " ");
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"]);
    hooks.beforeCommit = undefined;
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/changed while running; nothing was written/);
    expect(existsSync(env.deployDir)).toBe(false);
    expect(readdirSync(env.configDir)).toEqual(["settings.json"]);
  });
});
