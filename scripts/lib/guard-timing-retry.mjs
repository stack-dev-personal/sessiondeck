// Retry rules for the guard timing CI step (conductor decision 13). Pure functions: no I/O, so the
// default test run can cover them (test/guard-retry-classify.test.ts). The runner that spawns vitest
// and reads the report file is scripts/ci/guard-timing-retry.mjs.
//
// Rules, all of which must hold:
// - at most MAX_RUN_ATTEMPTS attempts of the whole run;
// - an attempt is retried only when it failed and EVERY failed test failed on a timing bound (the
//   test threw a TimingBoundError whose message starts with TIMING_BOUND_PREFIX);
// - anything else is final: a status, call count, execCommands or exit listener mismatch, a self
//   test or helper test failure, a hang kill, a suite level error, a missing or unreadable report,
//   a run in which no test ran, or an exit code that disagrees with the report.

/** Attempts of the whole guard timing run. Not a timing bound; it is not tuned by this file. */
export const MAX_RUN_ATTEMPTS = 3;

/** The message of a TimingBoundError starts with this text; the classifier keys on it. */
export const TIMING_BOUND_PREFIX = "timing bound violated:";

const TIMING_FAILURE = new RegExp(`^TimingBoundError: ${TIMING_BOUND_PREFIX}`);
const SUMMARY_LINE_MAX = 300;

/**
 * @typedef {"pass" | "timing" | "fail"} ResultKind
 * @typedef {{ kind: ResultKind, reason: string, rejected: string[] }} AttemptResult
 * @typedef {{ ok: boolean, attempts: number }} RetryOutcome
 * @typedef {Record<string, any>} JsonObject parsed vitest json reporter output (untrusted shape)
 */

/**
 * @param {ResultKind} kind
 * @param {string} reason
 * @param {string[]} [rejected]
 * @returns {AttemptResult}
 */
function result(kind, reason, rejected = []) {
  return { kind, reason, rejected };
}

/** @param {unknown} text */
function firstLine(text) {
  return (String(text).split("\n")[0] ?? "").slice(0, SUMMARY_LINE_MAX);
}

/**
 * The text after "TimingBoundError: " for a timing failure, else the first line of the message.
 * @param {string} message
 */
function summarize(message) {
  return firstLine(
    TIMING_FAILURE.test(message) ? message.slice("TimingBoundError: ".length) : message,
  );
}

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string | undefined} json
 * @returns {{ report: JsonObject, error?: undefined } | { report?: undefined, error: string }}
 */
function parseReport(json) {
  if (typeof json !== "string" || json.trim() === "")
    return { error: "report file missing or empty" };
  let report;
  try {
    report = JSON.parse(json);
  } catch (error) {
    return {
      error: `report is not valid JSON (${error instanceof Error ? error.message : error})`,
    };
  }
  if (
    !isRecord(report) ||
    !Array.isArray(report.testResults) ||
    typeof report.numTotalTests !== "number" ||
    typeof report.success !== "boolean"
  ) {
    return { error: "report has an unexpected shape" };
  }
  return { report };
}

/**
 * Classifies one finished attempt.
 * @param {{ exitCode: number | null, json: string | undefined }} input vitest's exit code and the
 *   text of the json reporter's file (undefined when the file does not exist).
 * @returns {AttemptResult}
 */
export function classifyRun({ exitCode, json }) {
  const parsed = parseReport(json);
  if (parsed.report === undefined) return result("fail", parsed.error);
  const { report } = parsed;
  const suites = report.testResults.filter(isRecord);
  const assertions = suites.flatMap((/** @type {JsonObject} */ suite) =>
    Array.isArray(suite.assertionResults) ? suite.assertionResults.filter(isRecord) : [],
  );
  const failedTests = assertions.filter(
    (/** @type {JsonObject} */ test) => test.status === "failed",
  );
  const passedTests = assertions.filter(
    (/** @type {JsonObject} */ test) => test.status === "passed",
  );
  const suiteErrors = suites.filter(
    (/** @type {JsonObject} */ suite) =>
      suite.status === "failed" &&
      !(
        Array.isArray(suite.assertionResults) &&
        suite.assertionResults.some((/** @type {JsonObject} */ t) => t?.status === "failed")
      ),
  );
  if (suiteErrors.length > 0) {
    const names = suiteErrors.map(
      (/** @type {JsonObject} */ suite) => `${suite.name}: ${firstLine(suite.message ?? "")}`,
    );
    return result("fail", `${suiteErrors.length} suite level failure(s)`, names);
  }
  if (failedTests.length === 0) {
    if (passedTests.length === 0) return result("fail", "no test ran");
    if (report.success && exitCode === 0) return result("pass", `${passedTests.length} passed`);
    return result(
      "fail",
      `no failed test in the report, but success=${report.success} exit=${exitCode}`,
    );
  }
  if (exitCode === 0 || report.success) {
    return result("fail", `report has failed tests but success=${report.success} exit=${exitCode}`);
  }
  const entries = failedTests.map((/** @type {JsonObject} */ test) => {
    const messages = Array.isArray(test.failureMessages) ? test.failureMessages.map(String) : [];
    const timing =
      messages.length > 0 &&
      messages.every((/** @type {string} */ message) => TIMING_FAILURE.test(message));
    const shown =
      messages.find((/** @type {string} */ message) => !TIMING_FAILURE.test(message)) ??
      messages[0];
    const name = test.fullName ?? test.title;
    return { timing, line: `${name}: ${summarize(shown ?? "(no failure message)")}` };
  });
  if (entries.every((/** @type {{ timing: boolean, line: string }} */ entry) => entry.timing)) {
    const lines = entries.map(
      (/** @type {{ timing: boolean, line: string }} */ entry) => entry.line,
    );
    return result("timing", `${entries.length} failed test(s), all on a timing bound`, lines);
  }
  // A mixed failure lists only the tests that are not timing failures: they make it final.
  const finals = entries
    .filter((/** @type {{ timing: boolean, line: string }} */ entry) => !entry.timing)
    .map((/** @type {{ timing: boolean, line: string }} */ entry) => entry.line);
  return result("fail", `${finals.length} failed test(s) not on a timing bound`, finals);
}

/**
 * Runs `runAttempt(n)` (n from 1) until it passes, fails for a reason that is not a timing bound,
 * or MAX_RUN_ATTEMPTS attempts are used. A thrown error is a runner error and final.
 * @param {{ runAttempt: (attempt: number) => Promise<AttemptResult>, log: (line: string) => void, maxAttempts?: number }} options
 * @returns {Promise<RetryOutcome>}
 */
export async function runWithRetry({ runAttempt, log, maxAttempts = MAX_RUN_ATTEMPTS }) {
  const cap = Math.min(maxAttempts, MAX_RUN_ATTEMPTS);
  for (let attempt = 1; attempt <= cap; attempt += 1) {
    let outcome;
    try {
      outcome = await runAttempt(attempt);
    } catch (error) {
      log(
        `guard timing attempt ${attempt} of ${cap}: runner error: ${error instanceof Error ? error.message : error}`,
      );
      return { ok: false, attempts: attempt };
    }
    log(`guard timing attempt ${attempt} of ${cap}: ${outcome.kind} (${outcome.reason})`);
    for (const line of outcome.rejected) log(`  rejected: ${line}`);
    if (outcome.kind === "pass") return { ok: true, attempts: attempt };
    if (outcome.kind === "fail") return { ok: false, attempts: attempt };
    if (attempt === cap) {
      log(`guard timing failed on a timing bound in all ${cap} attempts`);
    }
  }
  return { ok: false, attempts: cap };
}
