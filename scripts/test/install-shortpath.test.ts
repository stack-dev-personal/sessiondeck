import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  loadJson,
  makeTempDir,
  runInstallInProcess,
  SETTINGS_FIXTURE,
} from "./helpers";

afterAll(cleanupTempDirs);

/**
 * The 8.3 short form of an existing directory, or undefined when the platform is not Windows or
 * the volume has short names disabled (the answer then equals the long path).
 */
function shortFormOf(dir: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const r = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${dir}") do @echo %~sI`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const short = r.status === 0 ? r.stdout.trim() : "";
  return short !== "" && short.toLowerCase() !== dir.toLowerCase() ? short : undefined;
}

const longDir = makeTempDir();
const shortDir = shortFormOf(longDir);
const SKIP_REASON =
  process.platform === "win32"
    ? "8.3 short names are disabled on this volume"
    : "8.3 short names exist only on Windows";

describe("install flow when the temp root is given in 8.3 short form", () => {
  it.skipIf(shortDir === undefined)(
    shortDir === undefined ? `skipped: ${SKIP_REASON}` : "installs, re-installs and uninstalls",
    async () => {
      const sandbox = shortDir as string;
      expect(sandbox).toMatch(/~\d/);
      const configDir = join(sandbox, "config");
      mkdirSync(configDir);
      const target = join(configDir, "settings.json");
      copyFileSync(SETTINGS_FIXTURE, target);
      const original = JSON.stringify(loadJson(target));
      const run = (args: string[]) => runInstallInProcess(configDir, sandbox, args);

      expect((await run(["--apply"])).code).toBe(0);
      expect(JSON.stringify(loadJson(target))).toContain("sessiondeck-capture");
      const again = await run(["--apply"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toMatch(/Already installed/);
      const removed = await run(["--uninstall", "--apply"]);
      expect(removed.code).toBe(0);
      expect(JSON.stringify(loadJson(target))).toBe(original);
      expect(existsSync(join(sandbox, "deploy"))).toBe(false);
    },
  );
});
