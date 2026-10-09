import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..");
export const CAPTURE_SCRIPT = join(SCRIPTS_DIR, "capture-fixtures.mjs");
export const INSTALL_SCRIPT = join(SCRIPTS_DIR, "capture-install.mjs");
export const SETTINGS_FIXTURE = resolve(
  SCRIPTS_DIR,
  "..",
  "packages",
  "contract",
  "fixtures",
  "settings",
  "with-harness-hooks.json",
);

export const TARGET_PREFIX = "Target settings file: ";
const LINE_BREAK = /\r?\n/;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sd-capture-test-"));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function isInside(root: string, candidate: string): boolean {
  return resolve(candidate).startsWith(resolve(root) + sep);
}

const SANDBOXED_VARS = ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME"];
const SCRUBBED_VARS = [
  "CLAUDECODE",
  "CLAUDE_CONFIG_DIR",
  "SESSIONDECK_CAPTURE_HOME",
  "SESSIONDECK_CAPTURE_DIR",
];

/**
 * Environment for a child or in-process run: every home-like variable points into the sandbox, and
 * variables that could redirect to real locations are removed unless extra sets them.
 */
export function sandboxEnv(sandbox: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SCRUBBED_VARS) delete env[name];
  for (const name of SANDBOXED_VARS) env[name] = sandbox;
  return { ...env, ...extra };
}

/** Spawns a script with the real node binary. Home variables always point into a temp dir. */
export function runScript(
  script: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string>; sandbox: string },
): Promise<RunResult> {
  const env = sandboxEnv(opts.sandbox, opts.env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

/** Directory the installer deploys its hook copy into during tests. */
export function deployDirFor(sandbox: string): string {
  return join(sandbox, "deploy");
}

function installArgs(
  configDir: string,
  sandbox: string,
  args: string[],
  extraEnv: Record<string, string>,
) {
  if (!isInside(sandbox, configDir)) throw new Error("test bug: config dir outside sandbox");
  const deploy = extraEnv.SESSIONDECK_CAPTURE_HOME ?? deployDirFor(sandbox);
  if (!isInside(sandbox, deploy)) throw new Error("test bug: deploy dir outside sandbox");
  const argv = args.includes("--out") ? args : [...args, "--out", join(sandbox, "raw")];
  const env = { ...extraEnv, CLAUDE_CONFIG_DIR: configDir, SESSIONDECK_CAPTURE_HOME: deploy };
  return { argv, env };
}

/**
 * Runs the installer as a child process. Refuses to run unless the config dir and the deploy dir
 * are inside the sandbox, and asserts the printed target. Without an explicit --out the raw
 * directory is <sandbox>/raw, never the repository's.
 */
export async function runInstall(
  configDir: string,
  sandbox: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const { argv, env } = installArgs(configDir, sandbox, args, extraEnv);
  const result = await runScript(INSTALL_SCRIPT, argv, { sandbox, env });
  const line = result.stdout.split(LINE_BREAK).find((l) => l.startsWith(TARGET_PREFIX));
  if (line !== undefined) {
    const printed = line.slice(TARGET_PREFIX.length);
    if (!isInside(sandbox, printed)) throw new Error(`target escaped sandbox: ${printed}`);
  }
  return result;
}

/** Runs the installer in this process (fast). Same sandbox rules as runInstall. */
export async function runInstallInProcess(
  configDir: string,
  sandbox: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const { run } = await import("../lib/install-cli.mjs");
  const { argv, env } = installArgs(configDir, sandbox, args, extraEnv);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({
    argv,
    env: sandboxEnv(sandbox, env),
    home: sandbox,
    realHome: sandbox,
    print: (t) => out.push(t),
    printErr: (t) => err.push(t),
  });
  return { code, stdout: `${out.join("\n")}\n`, stderr: `${err.join("\n")}\n` };
}

export interface InstallEnv {
  sandbox: string;
  configDir: string;
  target: string;
  deployDir: string;
}

/** A fresh sandbox with a config dir, optionally holding a copy of the harness settings fixture. */
export function setupInstallEnv(copyFixture = true): InstallEnv {
  const sandbox = makeTempDir();
  const configDir = join(sandbox, "config");
  mkdirSync(configDir);
  const target = join(configDir, "settings.json");
  if (copyFixture) copyFileSync(SETTINGS_FIXTURE, target);
  return { sandbox, configDir, target, deployDir: deployDirFor(sandbox) };
}

/** Parsed JSON file with loose typing, for assertions on settings content. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseJson = Record<string, any>;

export function loadJson(path: string): LooseJson {
  return JSON.parse(readFileSync(path, "utf8")) as LooseJson;
}

/** Every path below dir (relative, sorted), so a test can assert nothing was created or changed. */
export function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}
