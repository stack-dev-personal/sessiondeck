import { afterAll, describe, expect, it } from "vitest";
import {
  assertTargetInside,
  cleanupTempDirs,
  makeTempDir,
  runInstallInProcess,
  setupInstallEnv,
  TARGET_PREFIX,
} from "./helpers";

afterAll(cleanupTempDirs);

describe("the printed-target assertion (finding S6)", () => {
  it("passes for a target inside the sandbox and for output without a target line", () => {
    const sandbox = makeTempDir();
    expect(() =>
      assertTargetInside(`${TARGET_PREFIX}${sandbox}/c/settings.json\n`, sandbox),
    ).not.toThrow();
    expect(() => assertTargetInside("nothing printed\n", sandbox)).not.toThrow();
  });

  it("throws for a target outside the sandbox", () => {
    const sandbox = makeTempDir();
    const elsewhere = makeTempDir();
    expect(() =>
      assertTargetInside(`${TARGET_PREFIX}${elsewhere}/settings.json\n`, sandbox),
    ).toThrow(/target escaped sandbox/);
  });

  it("the in-process runner prints a target line for the assertion to check", async () => {
    const env = setupInstallEnv();
    const r = await runInstallInProcess(env.configDir, env.sandbox, []);
    expect(r.stdout.split("\n").some((l) => l.startsWith(TARGET_PREFIX))).toBe(true);
  });
});
