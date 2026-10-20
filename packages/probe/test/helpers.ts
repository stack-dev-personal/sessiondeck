import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const probeRoot = join(here, "..");
export const hookPath = join(probeRoot, "dist", "hook.mjs");
export const fixturesDir = join(probeRoot, "..", "contract", "fixtures");

export interface HookRun {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function runHook(
  stdin: Buffer | string | null,
  env: Record<string, string>,
  script: string = hookPath,
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
