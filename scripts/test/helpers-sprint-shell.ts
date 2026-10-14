import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * POSIX shell discovery and batched shell runs for the sprint image tests.
 *
 * On Windows every process start costs hundreds of milliseconds, so the tests run many small
 * cases inside one shell (runShellCases) instead of starting one shell per case, and the shell
 * probes below stop at the first working candidate.
 */

export const FORCE_PROBE_FAIL_VAR = "SPRINT_TEST_FORCE_SHELL_PROBE_FAIL";
// Each candidate must run a pipe through an external tool (tr), otherwise it is not used.
const PROBE_COMMAND = "echo x | tr x y";
const PROBE_EXPECTED = "y";
const PROBE_TIMEOUT_MS = 10_000;
// A batch runs dozens of cases; a case that never returns must fail the test, not stall the worker.
export const SHELL_RUN_TIMEOUT_MS = 50_000;

/**
 * The environment for running a shell: when the shell is an absolute path (Git for Windows
 * usr/bin), its own folder goes first on PATH so tools like tr, sed and awk resolve.
 */
export function shellEnv(shell: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const base = process.env[pathKey] ?? "";
  const path = isAbsolute(shell) ? dirname(shell) + delimiter + base : base;
  return { ...process.env, ...extra, [pathKey]: path };
}

function probeWorks(candidate: string): boolean {
  const probe = spawnSync(candidate, ["-c", PROBE_COMMAND], {
    encoding: "utf8",
    env: shellEnv(candidate),
    timeout: PROBE_TIMEOUT_MS,
  });
  return probe.status === 0 && probe.stdout.trim() === PROBE_EXPECTED;
}

function windowsInstallCandidates(name: string): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined,
  ];
  return roots.flatMap((root) => (root ? [join(root, "Git", "usr", "bin", `${name}.exe`)] : []));
}

/** Asks git where it lives; only called when no standard install location worked. */
function gitExecPathCandidate(name: string): string[] {
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (exec.status !== 0 || !exec.stdout.trim()) return [];
  return [join(exec.stdout.trim(), "..", "..", "..", "usr", "bin", `${name}.exe`)];
}

/**
 * A POSIX shell that works: the bare name on Linux and macOS. On Windows, Git for Windows'
 * usr/bin copy comes first (standard install folders, then the folder git itself reports), and
 * the bare name last, because the bare "bash" there can be the WSL launcher, which fails when no
 * distro is installed and is the wrong shell when one is.
 */
export function findPosixShell(name: "sh" | "bash"): string | undefined {
  if (process.env[FORCE_PROBE_FAIL_VAR]) return undefined;
  if (process.platform !== "win32") return [name].find(probeWorks);
  return (
    windowsInstallCandidates(name).find(probeWorks) ??
    gitExecPathCandidate(name).find(probeWorks) ??
    [name].find(probeWorks)
  );
}

export interface ShellCaseResult {
  status: number;
  /** stdout and stderr of the case, interleaved in the order the shell wrote them. */
  output: string;
}

const MARKER_PREFIX = "@@CASE";

/**
 * Runs every body as a function of ONE shell process, after `prelude` ran once in the parent.
 * Bodies end with `return N` (never `exit`, which would end the whole shell) and must set any
 * state they depend on themselves, since functions share the shell's variables. Functions are
 * used instead of subshells because forking costs about 100 ms per subshell under Git for
 * Windows. Returns one result per body, in order. Throws when the shell output cannot be matched
 * back, so a crashed shell never reads as a pass.
 */
export function runShellCases(
  shell: string,
  prelude: string,
  bodies: readonly string[],
): ShellCaseResult[] {
  // A fresh id per run, so a case cannot print text that parses as its own or another marker.
  const runId = randomUUID();
  const begin = `${MARKER_PREFIX}-${runId}-BEGIN`;
  const end = `${MARKER_PREFIX}-${runId}-END`;
  const cases = bodies.map(
    (body, i) =>
      `sd_case_${i}() {\n${body}\n}\nprintf '%s\\n' '${begin} ${i}'\nsd_case_${i} 2>&1\nprintf '\\n%s %s\\n' '${end} ${i}' "$?"\n`,
  );
  const result = spawnSync(shell, ["-s"], {
    input: `${prelude}\n${cases.join("")}`,
    encoding: "utf8",
    env: shellEnv(shell),
    timeout: SHELL_RUN_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw new Error(
      `shell did not finish ${bodies.length} cases within ${SHELL_RUN_TIMEOUT_MS} ms: ${result.error.message}`,
    );
  }
  const results = new Map<number, ShellCaseResult>();
  const pattern = new RegExp(`${begin} (\\d+)\\n([\\s\\S]*?)\\n${end} \\1 (\\d+)\\n`, "g");
  for (const match of result.stdout.matchAll(pattern)) {
    results.set(Number(match[1]), { output: match[2] ?? "", status: Number(match[3]) });
  }
  return bodies.map((_body, i) => {
    const found = results.get(i);
    if (found === undefined) {
      throw new Error(
        `shell case ${i} of ${bodies.length} produced no result (shell status ${result.status}): ${result.stderr}`,
      );
    }
    return found;
  });
}
