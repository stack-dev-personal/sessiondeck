import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRoot } from "../helpers.ts";

export const cliPath = join(probeRoot, "dist", "probe.mjs");
export const harnessFixture = join(
  probeRoot,
  "..",
  "contract",
  "fixtures",
  "settings",
  "with-harness-hooks.json",
);

export interface Sandbox {
  root: string;
  configDir: string;
  settings: string;
  home: string;
  env: Record<string, string>;
}

/** Temp CLAUDE_CONFIG_DIR and probe home (passed as --home by runCli); HOME is redirected too so nothing real is touched. */
export function sandbox(fixture?: string, normalize = false): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "sd-install-"));
  const configDir = join(root, "claude");
  const home = join(root, "probe-home");
  const fakeHome = join(root, "home");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  const settings = join(configDir, "settings.json");
  if (fixture && normalize) {
    // Re-serialized with 2-space indent: the form the probe writes, so byte equality is testable.
    writeFileSync(
      settings,
      `${JSON.stringify(JSON.parse(readFileSync(fixture, "utf8")), null, 2)}\n`,
    );
  } else if (fixture) {
    copyFileSync(fixture, settings);
  }
  return {
    root,
    configDir,
    settings,
    home,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      SD_TEST_HOME: home,
      CLAUDECODE: "",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      // runCli adds --runtime <this> to `install` unless the test passes its own (the default
      // exe form needs the built exes; most suites exercise the Node form).
      SD_TEST_RUNTIME: "node",
    },
  };
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<CliRun> {
  const testHome = env["SD_TEST_HOME"];
  const withHome = testHome && !args.includes("--home") ? [...args, "--home", testHome] : args;
  const runtime = env["SD_TEST_RUNTIME"];
  const argv =
    runtime && args[0] === "install" && !args.some((a) => a.startsWith("--runtime"))
      ? [...withHome, "--runtime", runtime]
      : withHome;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });
}

export const readText = (p: string): string => readFileSync(p, "utf8");
// Test-only: settings documents are inspected loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = any;
export const readJson = (p: string): Doc => JSON.parse(readText(p));
export const writeText = (p: string, t: string): void => writeFileSync(p, t);
