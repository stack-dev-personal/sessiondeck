// CI entry for the guard timing run (R0.5, conductor decision 13): runs
// `vitest run --config vitest.guard-timing.config.ts` with the json reporter and runs the whole
// thing again, up to 3 attempts, only when every failed test failed on a timing bound. The rules
// and the classifier are in ../lib/guard-timing-retry.mjs (unit tested in the default run).
//
// Exit codes: 0 green, 1 a failure (timing in all attempts, a functional failure, or a runner
// error such as a missing or unreadable report). A missing report is never a pass.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRun, runWithRetry } from "../lib/guard-timing-retry.mjs";

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `.vite/` is gitignored (and ignored by prettier), so the report never lands in a commit.
const REPORT_PATH = resolve(scriptsDir, ".vite", "guard-timing-report.json");
const CONFIG = "vitest.guard-timing.config.ts";

function vitestEntry() {
  const require = createRequire(resolve(scriptsDir, "package.json"));
  return resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
}

/** One vitest run; resolves with its exit code. The child inherits stdio, so its output is the log. */
function runVitest() {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestEntry(),
        "run",
        "--config",
        CONFIG,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${REPORT_PATH}`,
      ],
      { cwd: scriptsDir, stdio: "inherit", windowsHide: true },
    );
    child.on("error", reject);
    child.on("close", (code) => resolveRun(code ?? 1));
  });
}

function readReport() {
  try {
    return readFileSync(REPORT_PATH, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function attempt() {
  // A stale report from an earlier attempt must never be read as this attempt's result.
  rmSync(REPORT_PATH, { force: true });
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const exitCode = await runVitest();
  return classifyRun({ exitCode, json: readReport() });
}

async function main() {
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await runWithRetry({ runAttempt: attempt, log: (line) => console.info(line) });
  } finally {
    rmSync(REPORT_PATH, { force: true });
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.info(
    `guard timing: ${outcome.ok ? "passed" : "FAILED"} after ${outcome.attempts} attempt(s), ${seconds} s`,
  );
  return outcome.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`guard timing runner error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  },
);
