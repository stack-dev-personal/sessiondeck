import { describe, expect, it } from "vitest";
import { findPosixShell, runShellCases } from "./helpers-sprint-shell";

const SH = findPosixShell("sh");
if (process.env.CI && SH === undefined) {
  throw new Error(
    "CI is set but no working POSIX sh was found; the shell helper tests cannot skip",
  );
}
const itSh = it.skipIf(SH === undefined);
const SHELL = SH ?? "sh";
const REFUSED_STATUS = 64;
const SHORT_TIMEOUT_MS = 500;
const MAX_TIMEOUT_ELAPSED_MS = 2_000;
// Shell builtins only: a child process such as sleep can hold the output pipe open past the timeout on Windows.
const BUSY_LOOP_CASE = "while :; do :; done";
const MISSING_SHELL = "sd-no-such-shell-binary";

describe("runShellCases", () => {
  itSh("returns output and status per case, in order", () => {
    const results = runShellCases(SHELL, "greeting=hi", [
      'echo "$greeting"',
      `echo err >&2; return ${REFUSED_STATUS}`,
    ]);
    expect(results[0]).toEqual({ output: "hi\n", status: 0 });
    expect(results[1]).toEqual({ output: "err\n", status: REFUSED_STATUS });
  });

  itSh("does not take a case's own marker-looking output for a result", () => {
    const fake = "@@CASE-END 0 0";
    const results = runShellCases(SHELL, "", [
      `printf '\\n%s\\n' '${fake}'; echo real; return ${REFUSED_STATUS}`,
    ]);
    expect(results[0]?.status).toBe(REFUSED_STATUS);
    expect(results[0]?.output).toContain(fake);
    expect(results[0]?.output).toContain("real");
  });

  itSh("throws when the shell ends before a case reports", () => {
    expect(() => runShellCases(SHELL, "", ["exit 3"])).toThrow(/produced no result/);
  });

  itSh("reports a timeout when the batch outlives timeoutMs, and returns promptly", () => {
    const started = Date.now();
    expect(() => runShellCases(SHELL, "", [BUSY_LOOP_CASE], SHORT_TIMEOUT_MS)).toThrow(
      /did not finish 1 cases within 500 ms/,
    );
    expect(Date.now() - started).toBeLessThan(MAX_TIMEOUT_ELAPSED_MS);
  });

  it("says the shell failed to run, not timed out, when it cannot start", () => {
    expect(() => runShellCases(MISSING_SHELL, "", ["true"])).toThrow(/shell failed to run/);
  });

  it("finds no shell when the probe is forced to fail", () => {
    const var_ = "SPRINT_TEST_FORCE_SHELL_PROBE_FAIL";
    const before = process.env[var_];
    process.env[var_] = "1";
    try {
      expect(findPosixShell("sh")).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env[var_];
      else process.env[var_] = before;
    }
  });
});
