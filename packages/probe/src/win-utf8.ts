// Ported from sirmalloc/ccstatusline src/utils/windows-code-page.ts @ 3d94211 (MIT)
// Copyright (c) 2025 Matthew Breedlove
// Changes: standalone function with an injectable platform and runner for tests; chcp.com is
//   resolved to an absolute %SystemRoot%\System32 path (SystemRoot only if an absolute drive path,
//   else C:\Windows) and must exist, instead of a PATH/cwd lookup; spawned with cwd System32,
//   timeout 1000 ms, a minimal env, stdio ignored; skipped under Git Bash (MSYSTEM set); failures
//   swallowed; the caller invokes it only for non-ASCII output.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const SYSTEM_ROOT = /^[A-Za-z]:\\[^"%<>|*?]*$/;

/** Absolute System32 directory (Windows path syntax, regardless of host, so it is testable). */
export function system32Dir(env: NodeJS.ProcessEnv = process.env): string {
  const sr = env["SystemRoot"];
  const root = sr !== undefined && SYSTEM_ROOT.test(sr) ? sr.replace(/\\+$/, "") : "C:\\Windows";
  return `${root}\\System32`;
}

export type Runner = (file: string, args: string[], opts: { cwd: string; env: object }) => unknown;

const defaultRun: Runner = (file, args, opts) =>
  execFileSync(file, args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: "ignore",
    windowsHide: true,
    timeout: 1000,
  });

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Switches the console code page to UTF-8 (65001) so non-ASCII output survives in PowerShell/cmd.
 * No-op off Windows and under Git Bash (MSYSTEM set: bytes pass through). Failures are ignored.
 */
export function setWindowsUtf8(
  platform: NodeJS.Platform = process.platform,
  run: Runner = defaultRun,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = isFile,
): void {
  if (platform !== "win32") return;
  if (env["MSYSTEM"] !== undefined && env["MSYSTEM"] !== "") return;
  try {
    const dir = system32Dir(env);
    const exe = `${dir}\\chcp.com`;
    if (!exists(exe)) return;
    run(exe, ["65001"], { cwd: dir, env: { SystemRoot: dir.slice(0, -"\\System32".length) } });
  } catch {
    // ignore
  }
}
