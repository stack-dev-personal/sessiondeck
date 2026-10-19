import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const guardPath = resolve(repoRoot, ".claude", "hooks", "guard.mjs");
export const BLOCKED = 2;
export const ALLOWED = 0;

export interface GuardResult {
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Runs the real guard.mjs once inside a worker thread instead of a child process, and returns its
 * exit status and stderr. The guard reads stdin through process.stdin events, writes stderr and
 * ends with process.exit, which in a worker ends only that worker; its only import is
 * node:child_process. Every worker loads a fresh module instance, so the file runs unchanged. This
 * costs a few ms where a node process costs 0.5 to 2 s on a loaded 4-core runner, which is what
 * makes the table rows of guard-rules.test.ts cheap. `runGuardProcessRaw` is the real-process
 * reference; guard-rules.test.ts proves the two agree (exit status and stderr).
 */
export function runGuardRaw(input: string): Promise<GuardResult> {
  return new Promise((resolveRun, rejectRun) => {
    const worker = new Worker(pathToFileURL(guardPath), {
      stdin: true,
      stdout: true,
      stderr: true,
    });
    let stderr = "";
    let status: number | null = null;
    let exited = false;
    let stderrEnded = false;
    const finish = (): void => {
      if (exited && stderrEnded) {
        resolveRun({ status, stderr });
      }
    };
    worker.stdout.resume(); // the guard writes nothing to stdout; drain anyway
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    worker.stderr.on("end", () => {
      stderrEnded = true;
      finish();
    });
    worker.on("error", rejectRun);
    worker.on("exit", (code) => {
      status = code;
      exited = true;
      finish();
    });
    worker.stdin?.on("error", () => undefined); // the worker may exit before reading all input
    worker.stdin?.end(input);
  });
}

/**
 * Runs the guard once as a real node process with a raw stdin payload and returns its exit status
 * and stderr. Async, so tests can run concurrently (vitest `it.concurrent`) instead of blocking the
 * worker on each spawn. Used for the end-to-end rows and as the reference for the worker runner.
 */
export function runGuardProcessRaw(input: string): Promise<GuardResult> {
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

export function bashPayload(command: string): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd: repoRoot,
  });
}

/** Run the guard (worker runner) once with a Bash tool call. */
export function runGuard(command: string): Promise<GuardResult> {
  return runGuardRaw(bashPayload(command));
}

/** Run the guard (real process) once with a Bash tool call. */
export function runGuardProcess(command: string): Promise<GuardResult> {
  return runGuardProcessRaw(bashPayload(command));
}
