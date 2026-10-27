import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const probeRoot = join(here, "..");
export const hookPath = join(probeRoot, "dist", "hook.mjs");
/** Bun-compiled hook for this platform (build with `pnpm build:exe`); null when not built. */
export const hookExePath: string | null = (() => {
  const dir = join(
    probeRoot,
    "dist",
    "exe",
    process.platform === "win32" ? "windows-x64" : "linux-x64",
  );
  const file = join(dir, process.platform === "win32" ? "hook.exe" : "hook");
  return existsSync(file) ? file : null;
})();

export const fixturesDir = join(probeRoot, "..", "contract", "fixtures");

export interface HookRun {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface HookOpts {
  /** Probe home passed as `--home` (the way `probe install` registers the hook). */
  home?: string;
  host?: string;
  env?: Record<string, string>;
  args?: string[];
}

export function hookArgs(o: HookOpts): string[] {
  return [
    ...(o.home !== undefined ? ["--home", o.home] : []),
    ...(o.host !== undefined ? ["--host", o.host] : []),
    "--sessiondeck-probe",
    ...(o.args ?? []),
  ];
}

export function runHook(
  stdin: Buffer | string | null,
  opts: HookOpts,
  script: string = hookPath,
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const direct = !script.endsWith(".mjs");
    const child = spawn(
      direct ? script : process.execPath,
      [...(direct ? [] : [script]), ...hookArgs(opts)],
      {
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
    // The hook may exit before reading all of a large input; EPIPE is not a test failure.
    child.stdin.on("error", () => undefined);
    if (stdin === null) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

/** One fixture file path per hook event directory (the first file of each). */
export function fixturePerEvent(): { event: string; file: string }[] {
  const events = [
    "Notification",
    "PermissionRequest",
    "PostCompact",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
  ];
  return events.map((event) => {
    const files = readdirSync(join(fixturesDir, event))
      .filter((f) => f.endsWith(".json"))
      .sort();
    return { event, file: join(fixturesDir, event, files[0] as string) };
  });
}

export function readSpoolLines(spool: string): string[] {
  return readdirSync(spool)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => readFileSync(join(spool, f), "utf8").split("\n").filter(Boolean));
}
