import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = resolve(here, "..");
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

/** Spawns a script with the real node binary. Home variables always point into a temp dir. */
export function runScript(
  script: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string>; sandbox: string },
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.sandbox,
    USERPROFILE: opts.sandbox,
    ...opts.env,
  };
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

/** Runs the installer. Refuses to run unless the config dir is inside the sandbox, and asserts the printed target. */
export async function runInstall(
  configDir: string,
  sandbox: string,
  args: string[] = [],
): Promise<RunResult> {
  if (!isInside(sandbox, configDir)) throw new Error("test bug: config dir outside sandbox");
  const result = await runScript(INSTALL_SCRIPT, args, {
    sandbox,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });
  const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith(TARGET_PREFIX));
  if (line !== undefined) {
    const printed = line.slice(TARGET_PREFIX.length);
    if (!isInside(sandbox, printed)) throw new Error(`target escaped sandbox: ${printed}`);
  }
  return result;
}
