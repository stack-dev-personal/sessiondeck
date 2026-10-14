import { spawnSync } from "node:child_process";
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
 * A POSIX shell that works: the bare name on Linux and macOS, and on Windows Git for Windows'
 * usr/bin copy first (the bare "bash" there can be the WSL launcher, which fails when no distro
 * is installed).
 */
export function findPosixShell(name: "sh" | "bash"): string | undefined {
  if (process.env[FORCE_PROBE_FAIL_VAR]) return undefined;
  const isWindows = process.platform === "win32";
  const standard = [...(isWindows ? windowsInstallCandidates(name) : []), name];
  const found = standard.find(probeWorks);
  if (found !== undefined || !isWindows) return found;
  return gitExecPathCandidate(name).find(probeWorks);
}

export interface ShellCaseResult {
  status: number;
  /** stdout and stderr of the case, interleaved in the order the shell wrote them. */
  output: string;
}

const CASE_BEGIN = "@@CASE-BEGIN";
const CASE_END = "@@CASE-END";

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
  const cases = bodies.map(
    (body, i) =>
      `sd_case_${i}() {\n${body}\n}\nprintf '%s\\n' '${CASE_BEGIN} ${i}'\nsd_case_${i} 2>&1\nprintf '\\n%s %s\\n' '${CASE_END} ${i}' "$?"\n`,
  );
  const result = spawnSync(shell, ["-s"], {
    input: `${prelude}\n${cases.join("")}`,
    encoding: "utf8",
    env: shellEnv(shell),
  });
  const results = new Map<number, ShellCaseResult>();
  const pattern = new RegExp(
    `${CASE_BEGIN} (\\d+)\\n([\\s\\S]*?)\\n${CASE_END} \\1 (\\d+)\\n`,
    "g",
  );
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
