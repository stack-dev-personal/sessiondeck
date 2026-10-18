import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const preloadUrl = pathToFileURL(resolve(here, "regexp-timing-preload.mjs")).href;

/** Spawn timeout: the real hook timeout is 5 s and a timeout lets the command run. */
export const MAX_WALL_MS = 4000;

export interface TimedRun {
  readonly status: number | null;
  readonly matchMs: number;
  readonly calls: number;
  readonly wallMs: number;
}

function readTotals(file: string): { matchMs: number; calls: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`timing file missing or unparsable: ${String(error)}`);
  }
  const totals = parsed as { matchMs?: unknown; calls?: unknown };
  if (typeof totals.matchMs !== "number" || typeof totals.calls !== "number") {
    throw new Error(`timing file has the wrong shape: ${JSON.stringify(parsed)}`);
  }
  return { matchMs: totals.matchMs, calls: totals.calls };
}

interface Exit {
  readonly status: number | null;
  readonly error?: Error;
}

function spawnWithInput(args: string[], input: string, timingFile: string): Promise<Exit> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, args, {
      timeout: MAX_WALL_MS,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, SD_GUARD_TIMING_FILE: timingFile },
    });
    child.on("error", (error) => resolveExit({ status: null, error }));
    child.on("close", (status) => resolveExit({ status }));
    child.stdin.on("error", () => undefined); // child may exit before reading all input
    child.stdin.end(input);
  });
}

/**
 * Runs a node script with the regex timing preload. The stdin JSON has the shape the guard hook
 * receives. A missing or unparsable timing file throws, so it can never read as 0 ms. Async so
 * tests can run concurrently inside one worker instead of blocking it on each spawn.
 */
export async function runTimed(
  scriptPath: string,
  command: string,
  cwd: string,
): Promise<TimedRun> {
  const dir = mkdtempSync(join(tmpdir(), "sd-guard-timing-"));
  const timingFile = join(dir, "timing.json");
  try {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });
    const start = performance.now();
    const exit = await spawnWithInput(["--import", preloadUrl, scriptPath], input, timingFile);
    const wallMs = performance.now() - start;
    if (exit.error) {
      throw new Error(`spawn failed: ${exit.error.message}`);
    }
    return { status: exit.status, ...readTotals(timingFile), wallMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Lowest matchMs of `repeats` sequential runs, with the calls, status and wall time of that run. */
export async function runTimedBest(
  scriptPath: string,
  command: string,
  cwd: string,
  repeats: number,
): Promise<TimedRun> {
  const runs: TimedRun[] = [];
  for (let i = 0; i < repeats; i += 1) {
    runs.push(await runTimed(scriptPath, command, cwd));
  }
  return runs.reduce((best, run) => (run.matchMs < best.matchMs ? run : best));
}
