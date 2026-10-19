import { describe, expect, it, vi } from "vitest";
import {
  classifyRun,
  MAX_RUN_ATTEMPTS,
  runWithRetry,
  TIMING_BOUND_PREFIX,
  type AttemptResult,
} from "../lib/guard-timing-retry.mjs";

// The classifier decides whether a failed guard timing run may be run again (conductor decision
// 13). It reads the JSON that vitest's json reporter writes. These tests build that shape by hand;
// the end-to-end run of the real reporter is `pnpm -F @sessiondeck/scripts test:guard-timing:ci`.
// This file is deliberately not named guard-timing*, so it runs in the default suite.

const TIMING_MESSAGE = `TimingBoundError: ${TIMING_BOUND_PREFIX} matchMs 400.0 >= 150\n    at stack`;
const FUNCTIONAL_MESSAGE = "AssertionError: expected 2 to be 0 // Object.is equality\n    at stack";

interface Assertion {
  readonly fullName: string;
  readonly status: "passed" | "failed" | "pending";
  readonly failureMessages: readonly string[];
}

const passed = (name: string): Assertion => ({
  fullName: name,
  status: "passed",
  failureMessages: [],
});
const failed = (name: string, ...messages: string[]): Assertion => ({
  fullName: name,
  status: "failed",
  failureMessages: messages,
});

function report(assertions: readonly Assertion[], overrides: Record<string, unknown> = {}): string {
  const failedCount = assertions.filter((a) => a.status === "failed").length;
  const passedCount = assertions.filter((a) => a.status === "passed").length;
  return JSON.stringify({
    success: failedCount === 0,
    numTotalTests: assertions.length,
    numFailedTests: failedCount,
    numPassedTests: passedCount,
    testResults: [
      {
        name: "guard-timing.test.ts",
        status: failedCount === 0 ? "passed" : "failed",
        message: "",
        assertionResults: assertions,
      },
    ],
    ...overrides,
  });
}

describe("classifyRun: which failed guard timing runs may be retried", () => {
  it("passes a green run with exit code 0", () => {
    const result = classifyRun({ exitCode: 0, json: report([passed("a"), passed("b")]) });
    expect(result.kind).toBe("pass");
  });

  it("retries when every failed test failed on a timing bound", () => {
    const json = report([
      passed("a"),
      failed("row 1", TIMING_MESSAGE),
      failed("row 2", TIMING_MESSAGE),
    ]);
    const result = classifyRun({ exitCode: 1, json });
    expect(result.kind).toBe("timing");
    expect(result.rejected).toEqual([
      `row 1: ${TIMING_BOUND_PREFIX} matchMs 400.0 >= 150`,
      `row 2: ${TIMING_BOUND_PREFIX} matchMs 400.0 >= 150`,
    ]);
  });

  it("does not retry a mixed failure (one timing, one functional)", () => {
    const json = report([failed("row 1", TIMING_MESSAGE), failed("row 2", FUNCTIONAL_MESSAGE)]);
    const result = classifyRun({ exitCode: 1, json });
    expect(result.kind).toBe("fail");
    expect(result.rejected).toEqual([`row 2: ${FUNCTIONAL_MESSAGE.split("\n")[0]}`]);
  });

  it("does not retry a functional failure (status, call count, exec command, hang, listener)", () => {
    for (const message of [
      "AssertionError: expected 0 to be 2",
      "AssertionError: expected [] to deeply equal [ 'git rev-parse --abbrev-ref HEAD' ]",
      "GuardKilledError: guard killed after 10000 ms wall (signal SIGTERM)",
      "Error: exit listener added after the preload",
    ]) {
      const result = classifyRun({ exitCode: 1, json: report([failed("row", message)]) });
      expect(result.kind, message).toBe("fail");
    }
  });

  it("does not retry when a failure carries a timing message and another message", () => {
    const json = report([failed("row", TIMING_MESSAGE, FUNCTIONAL_MESSAGE)]);
    expect(classifyRun({ exitCode: 1, json }).kind).toBe("fail");
  });

  it("does not accept the prefix anywhere but at the start of the error", () => {
    const sneaky = `AssertionError: ${TIMING_BOUND_PREFIX} pasted into another error`;
    expect(classifyRun({ exitCode: 1, json: report([failed("row", sneaky)]) }).kind).toBe("fail");
  });

  it("fails when the JSON file is missing or empty", () => {
    expect(classifyRun({ exitCode: 0, json: undefined }).kind).toBe("fail");
    expect(classifyRun({ exitCode: 1, json: undefined }).kind).toBe("fail");
    expect(classifyRun({ exitCode: 0, json: "" }).kind).toBe("fail");
  });

  it("fails when the JSON is unparseable or has an unexpected shape", () => {
    for (const json of ["{not json", "[]", "null", "{}", '{"testResults":[]}']) {
      expect(classifyRun({ exitCode: 0, json }).kind, json).toBe("fail");
    }
  });

  it("fails a run in which no test ran, even with exit code 0", () => {
    expect(classifyRun({ exitCode: 0, json: report([]) }).kind).toBe("fail");
  });

  it("fails when the exit code disagrees with the report", () => {
    expect(classifyRun({ exitCode: 1, json: report([passed("a")]) }).kind).toBe("fail");
    const timing = report([failed("row", TIMING_MESSAGE)]);
    expect(classifyRun({ exitCode: 0, json: timing }).kind).toBe("fail");
  });

  it("fails a suite level failure that has no failed test (import error, setup error)", () => {
    const json = report([passed("a")], {
      success: false,
      testResults: [
        {
          name: "x.test.ts",
          status: "failed",
          message: "Cannot find module",
          assertionResults: [],
        },
        { name: "y.test.ts", status: "passed", message: "", assertionResults: [passed("a")] },
      ],
    });
    expect(classifyRun({ exitCode: 1, json }).kind).toBe("fail");
  });
});

describe("runWithRetry: bounded attempts", () => {
  const pass: AttemptResult = { kind: "pass", reason: "ok", rejected: [] };
  const timing: AttemptResult = {
    kind: "timing",
    reason: "1 failed test, all on a timing bound",
    rejected: ["row: timing bound violated: matchMs 400.0 >= 150"],
  };
  const fail: AttemptResult = { kind: "fail", reason: "functional", rejected: ["row: x"] };

  function script(results: readonly AttemptResult[]) {
    const runAttempt = vi.fn(async (attempt: number) => {
      const next = results[Math.min(attempt - 1, results.length - 1)];
      if (next === undefined) throw new Error("script needs a result");
      return next;
    });
    const lines: string[] = [];
    return { runAttempt, lines, log: (line: string) => lines.push(line) };
  }

  it("uses at most 3 attempts", () => {
    expect(MAX_RUN_ATTEMPTS).toBe(3);
  });

  it("returns after a first green attempt", async () => {
    const s = script([pass]);
    const outcome = await runWithRetry(s);
    expect(outcome).toEqual({ ok: true, attempts: 1 });
    expect(s.runAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries a timing failure and passes on the next attempt", async () => {
    const s = script([timing, pass]);
    const outcome = await runWithRetry(s);
    expect(outcome).toEqual({ ok: true, attempts: 2 });
    expect(s.lines.join("\n")).toContain("matchMs 400.0 >= 150");
    expect(s.lines.join("\n")).toContain("attempt 1 of 3");
  });

  it("stops after the 3rd timing failure and reports failure", async () => {
    const s = script([timing]);
    const outcome = await runWithRetry(s);
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(s.runAttempt).toHaveBeenCalledTimes(3);
  });

  it("never exceeds the cap even when asked for more", async () => {
    const s = script([timing]);
    const outcome = await runWithRetry({ ...s, maxAttempts: 10 });
    expect(outcome.attempts).toBe(3);
    expect(s.runAttempt).toHaveBeenCalledTimes(3);
  });

  it("does not retry a functional failure", async () => {
    const s = script([fail, pass]);
    const outcome = await runWithRetry(s);
    expect(outcome).toMatchObject({ ok: false, attempts: 1 });
    expect(s.runAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry after a timing failure turns into a functional one", async () => {
    const s = script([timing, fail, pass]);
    const outcome = await runWithRetry(s);
    expect(outcome).toMatchObject({ ok: false, attempts: 2 });
  });

  it("treats a runner error as a failure at once", async () => {
    const lines: string[] = [];
    const runAttempt = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const outcome = await runWithRetry({ runAttempt, log: (line) => lines.push(line) });
    expect(outcome).toMatchObject({ ok: false, attempts: 1 });
    expect(lines.join("\n")).toContain("spawn failed");
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });
});
