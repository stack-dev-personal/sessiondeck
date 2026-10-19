import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const guardPath = resolve(repoRoot, ".claude", "hooks", "guard.mjs");
export const BLOCKED = 2;
export const ALLOWED = 0;

export interface GuardResult {
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Run the guard once with a raw stdin payload and return its exit status and stderr. Async, so
 * tests can run concurrently (vitest `it.concurrent`) instead of blocking the worker on each spawn.
 */
export function runGuardRaw(input: string): Promise<GuardResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [guardPath], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (status) => resolveRun({ status, stderr }));
    child.stdin.on("error", () => undefined); // child may exit before reading all input
    child.stdin.end(input);
  });
}

/** Run the guard once with a Bash tool call and return its exit status and stderr. */
export function runGuard(command: string): Promise<GuardResult> {
  return runGuardRaw(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: repoRoot,
    }),
  );
}
