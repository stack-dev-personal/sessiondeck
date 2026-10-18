import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const guardPath = resolve(repoRoot, ".claude", "hooks", "guard.mjs");
export const BLOCKED = 2;
export const ALLOWED = 0;

/** Run the guard once with a Bash tool call and return its exit status and stderr. */
export function runGuard(command: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd: repoRoot,
  });
  const result = spawnSync(process.execPath, [guardPath], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stderr: result.stderr };
}
