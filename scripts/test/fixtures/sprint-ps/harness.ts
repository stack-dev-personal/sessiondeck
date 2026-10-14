import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, REPO_ROOT } from "../../helpers";

/** Test harness for the sprint PowerShell scripts: a fake docker on PATH and a temp repo layout. */

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DOCKER_SOURCE = join(here, "fake-docker.mjs");
const SECRET_ENV = /token|secret|password|api_key/i;
const SCRUBBED_PREFIXES = ["SPRINT_", "FAKE_DOCKER_", "ANTHROPIC_", "DOCKER_"];
export const SENTINEL = "SENTINEL-must-never-be-read-9f3a";
export const SPRINT_SCRIPTS = join(REPO_ROOT, "scripts", "sprint");

export interface Shell {
  path: string;
  name: string;
}

function probe(command: string): Shell | undefined {
  const r = spawnSync(
    command,
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).Path"],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0 || !r.stdout) return undefined;
  return { path: r.stdout.trim(), name: command };
}

/** pwsh when installed, else Windows PowerShell on Windows, else nothing (tests skip). */
function detectShell(): Shell | undefined {
  const pwsh = probe("pwsh");
  if (pwsh) return pwsh;
  return process.platform === "win32" ? probe("powershell.exe") : undefined;
}

export const SHELL = detectShell();
export const SKIP_REASON =
  "neither pwsh nor powershell.exe (Windows) was found, so the sprint PowerShell tests cannot run here";

export interface DockerCall {
  key: string;
  name: string | null;
  argv: string[];
  env: Record<string, string>;
  secretNames: string[];
}

export interface Step {
  code?: number;
  out?: string;
  err?: string;
  /** The call sleeps this long first (a stand-in for a slow image build). */
  delayMs?: number;
  /** Written when the step runs: a stand-in for the container writing its status file. */
  writeFile?: { path: string; content: string };
}

export interface DockerPlan {
  [key: string]: Step | { seq: Step[] };
}

export interface Workspace {
  /** Fake repo root: the two renderer inputs and a stub compose file. */
  repo: string;
  /** State root. Deliberately not named .sprint, and the env file is not inside it. */
  state: string;
  /** Env file holding only the sentinel. The scripts must never read it. */
  envFile: string;
  shimDir: string;
  log: string;
}

/** The origin URL text of the temp repo; run-sprint compares -RepoUrl against it. */
export const ORIGIN_URL = "https://github.com/Owner/Repo";
/** A -RepoUrl that run-sprint accepts for the temp repo (same repo, other spelling). */
export const SAME_REPO_URL = "https://github.com/owner/repo.git";

function gitInitWithOrigin(repo: string): void {
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", ORIGIN_URL],
  ]) {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

export function makeWorkspace(): Workspace {
  const base = makeTempDir();
  const repo = join(base, "repo");
  mkdirSync(join(repo, "infra", "sprint"), { recursive: true });
  for (const file of ["PROMPT-BOOK.md", "MINI-SPRINT-ORDER.md"]) {
    copyFileSync(join(REPO_ROOT, file), join(repo, file));
  }
  writeFileSync(join(repo, "infra", "sprint", "docker-compose.yml"), "# stub, never run\n");
  gitInitWithOrigin(repo);
  const state = join(base, "state");
  mkdirSync(state);
  const envFile = join(base, "fake-env-file.txt");
  writeFileSync(envFile, `CLAUDE_CODE_OAUTH_TOKEN=${SENTINEL}\nGH_TOKEN=${SENTINEL}\n`);
  const shimDir = join(base, "shim");
  mkdirSync(shimDir);
  installShim(shimDir, "docker", FAKE_DOCKER_SOURCE);
  return { repo, state, envFile, shimDir, log: join(base, "docker-calls.jsonl") };
}

/** A command shim named `name` that runs a node script (docker.cmd on Windows, sh elsewhere). */
function installShim(dir: string, name: string, nodeScript: string): void {
  const target = join(dir, "shim-target.mjs");
  copyFileSync(nodeScript, target);
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@"${process.execPath}" "%~dp0shim-target.mjs" %*\r\n@exit /b %ERRORLEVEL%\r\n`,
    );
    return;
  }
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/shim-target.mjs" "$@"\n`,
  );
  chmodSync(file, 0o755);
}

/** A directory whose only command is node, for the "docker is missing" case. */
export function makeNodeOnlyDir(): string {
  const dir = makeTempDir();
  const real = process.execPath;
  if (process.platform === "win32") {
    writeFileSync(join(dir, "node.cmd"), `@"${real}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  } else {
    const file = join(dir, "node");
    writeFileSync(file, `#!/bin/sh\nexec "${real}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

function childEnv(
  ws: Workspace,
  plan: DockerPlan,
  pathPrefix: string,
  replacePath: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const scrubbed = SECRET_ENV.test(k) || SCRUBBED_PREFIXES.some((p) => k.startsWith(p));
    if (!scrubbed && k.toLowerCase() !== "path") env[k] = v;
  }
  const inherited = process.env.PATH ?? process.env.Path ?? "";
  env.PATH = replacePath ? pathPrefix : `${pathPrefix}${delimiter}${inherited}`;
  env.FAKE_DOCKER_LOG = ws.log;
  env.FAKE_DOCKER_PLAN = JSON.stringify(plan);
  return env;
}

export function readCalls(ws: Workspace): DockerCall[] {
  if (!existsSync(ws.log)) return [];
  return readFileSync(ws.log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as DockerCall);
}

/** PowerShell string literal. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Switches and parameter names (-DryRun, -Sprint) go bare, every other token is a literal. */
function renderArg(token: string): string {
  return /^-[A-Z][A-Za-z]*$/.test(token) ? token : quote(token);
}

export interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BatchResult {
  runs: Invocation[];
  calls: DockerCall[];
  stdout: string;
  stderr: string;
}

export interface BatchOptions {
  plan?: DockerPlan;
  /** Replace PATH with just this directory (used for the missing-docker case). */
  onlyPath?: string;
  /** Extra environment for the PowerShell process (for example an ambient SPRINT_IMAGE). */
  env?: Record<string, string>;
}

function section(text: string, index: number): string {
  const begin = `@@BEGIN ${index}`;
  const start = text.indexOf(begin);
  if (start < 0) return "";
  const from = start + begin.length;
  const stop = text.indexOf("@@END", from);
  const nextBegin = text.indexOf(`@@BEGIN ${index + 1}`, from);
  const ends = [stop, nextBegin].filter((n) => n >= 0);
  return text.slice(from, ends.length > 0 ? Math.min(...ends) : undefined).trim();
}

/**
 * Runs `script` once per argument list inside ONE PowerShell process (starting PowerShell is the
 * expensive part), through a driver file. Stdout and stderr are split per invocation by markers.
 */
export function runBatch(
  ws: Workspace,
  script: string,
  argLists: string[][],
  options: BatchOptions = {},
): BatchResult {
  if (SHELL === undefined) throw new Error(SKIP_REASON);
  const lines: string[] = [];
  argLists.forEach((tokens, i) => {
    lines.push(`[Console]::Out.WriteLine('@@BEGIN ${i}')`);
    lines.push(`[Console]::Error.WriteLine('@@BEGIN ${i}')`);
    lines.push(`& ${quote(script)} ${tokens.map(renderArg).join(" ")}`);
    lines.push(`[Console]::Out.WriteLine('@@END ${i} ' + $LASTEXITCODE)`);
    lines.push(`[Console]::Error.WriteLine('@@END ${i}')`);
  });
  const driver = join(dirname(ws.log), "driver.ps1");
  writeFileSync(driver, `${lines.join("\n")}\n`);

  const pathPrefix = options.onlyPath ?? ws.shimDir;
  const r = spawnSync(
    SHELL.path,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...childEnv(ws, options.plan ?? {}, pathPrefix, options.onlyPath !== undefined),
        ...options.env,
      },
    },
  );
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const runs = argLists.map((_, i) => {
    const end = stdout.match(new RegExp(`@@END ${i} (-?\\d+)`));
    return {
      code: end ? Number(end[1]) : -1,
      stdout: section(stdout, i)
        .replace(/@@END.*$/m, "")
        .trim(),
      stderr: section(stderr, i),
    };
  });
  return { runs, calls: readCalls(ws), stdout, stderr };
}

export const RUN_SPRINT = join(SPRINT_SCRIPTS, "run-sprint.ps1");
export const STATUS = join(SPRINT_SCRIPTS, "status.ps1");
export const STOP_SPRINT = join(SPRINT_SCRIPTS, "stop-sprint.ps1");
export const SMOKE_CHECK = join(SPRINT_SCRIPTS, "smoke-check.ps1");

/** Common arguments that point run-sprint at the temp workspace. */
export function runArgs(
  ws: Workspace,
  sprint: string,
  extra: string[] = [],
  repoUrl: string = SAME_REPO_URL,
): string[] {
  return [
    "-Sprint",
    sprint,
    "-RepoRoot",
    ws.repo,
    "-StateRoot",
    ws.state,
    "-EnvFile",
    ws.envFile,
    "-RepoUrl",
    repoUrl,
    ...extra,
  ];
}

/** Same form the scripts hand to docker: absolute with forward slashes. */
export function dockerForm(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}
