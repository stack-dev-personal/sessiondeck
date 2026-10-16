import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";

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
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "sd-capture-test-"));
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

interface HookMain {
  main: (io: {
    argv: string[];
    env: NodeJS.ProcessEnv;
    stdin: AsyncIterable<string | Buffer>;
    stdout: (text: string) => void;
    now?: () => number;
  }) => Promise<void>;
}

/**
 * Runs a hook entry file (the repo's or a copy in a temp dir) in this process through its exported
 * `main`, with the same sandboxed environment runScript would give a child. Nothing is written to
 * process.env or the working directory. Direct writes to process.stdout / process.stderr during the
 * call (which the hook must never make) are collected into stdout / stderr so tests still see them.
 * The exit code is always 0, as the entry file's wrapper sets.
 */
export async function runHookInProcess(
  script: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string>; sandbox: string; trackStray?: boolean },
): Promise<RunResult> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(script).href)) as HookMain;
  const out: string[] = [];
  const err: string[] = [];
  const stray = (sink: string[]) => (chunk: unknown) => {
    sink.push(String(chunk));
    return true;
  };
  // Overlapping calls would share one spy, so concurrent callers pass trackStray: false.
  const track = opts.trackStray !== false;
  const outSpy = track
    ? vi.spyOn(process.stdout, "write").mockImplementation(stray(out))
    : undefined;
  const errSpy = track
    ? vi.spyOn(process.stderr, "write").mockImplementation(stray(err))
    : undefined;
  try {
    await mod.main({
      argv: args,
      env: sandboxEnv(opts.sandbox, opts.env),
      stdin: Readable.from([Buffer.from(opts.input ?? "", "utf8")]),
      stdout: (text) => out.push(text),
    });
  } finally {
    outSpy?.mockRestore();
    errSpy?.mockRestore();
  }
  return { code: 0, stdout: out.join(""), stderr: err.join("") };
}

/** Test-only argument: do not add --out, so the installer's own default applies. */
export const KEEP_DEFAULT_OUT = "--keep-default-out";

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
  const useDefault = args.includes(KEEP_DEFAULT_OUT);
  const given = args.filter((a) => a !== KEEP_DEFAULT_OUT);
  const argv =
    useDefault || args.includes("--out") ? given : [...given, "--out", join(sandbox, "raw")];
  const env = { ...extraEnv, CLAUDE_CONFIG_DIR: configDir, SESSIONDECK_CAPTURE_HOME: deploy };
  return { argv, env };
}

/**
 * Runs the installer as a child process. Refuses to run unless the config dir and the deploy dir
 * are inside the sandbox, and asserts the printed target. Without an explicit --out the raw
 * directory is <sandbox>/raw, never the repository's, unless KEEP_DEFAULT_OUT is passed (then the
 * installer's default, <deploy home>/raw, applies; the deploy home is inside the sandbox).
 */
export async function runInstall(
  configDir: string,
  sandbox: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const { argv, env } = installArgs(configDir, sandbox, args, extraEnv);
  const result = await runScript(INSTALL_SCRIPT, argv, { sandbox, env });
  assertTargetInside(result.stdout, sandbox);
  return result;
}

/** Throws when the settings file the installer printed is not inside the sandbox. */
export function assertTargetInside(stdout: string, sandbox: string): void {
  const line = stdout.split(LINE_BREAK).find((l) => l.startsWith(TARGET_PREFIX));
  if (line === undefined) return;
  const printed = line.slice(TARGET_PREFIX.length);
  if (!isInside(sandbox, printed)) throw new Error(`target escaped sandbox: ${printed}`);
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
  const stdout = `${out.join("\n")}\n`;
  assertTargetInside(stdout, sandbox);
  return { code, stdout, stderr: `${err.join("\n")}\n` };
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
