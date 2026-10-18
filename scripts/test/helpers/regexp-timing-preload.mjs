// Preload for guard timing tests: measures time spent inside regex matching in a child process.
// RegExp.prototype.test, match, replace, search and split all call RegExp.prototype.exec, so one
// wrapper covers every regex call and nothing is counted twice. Built-ins that do not use regexes
// (toLowerCase, includes, JSON.parse, String) are linear and deliberately not measured.
// On process exit (which also fires for process.exit) the totals are written as JSON to the file
// named by SD_GUARD_TIMING_FILE.
import { writeFileSync } from "node:fs";

const timingFile = process.env.SD_GUARD_TIMING_FILE;
if (!timingFile) {
  throw new Error("SD_GUARD_TIMING_FILE is not set");
}

const originalExec = RegExp.prototype.exec;
const totals = { matchMs: 0, calls: 0 };

/**
 * @this {RegExp}
 * @param {string} subject
 */
RegExp.prototype.exec = function timedExec(subject) {
  const start = performance.now();
  try {
    return Reflect.apply(originalExec, this, [subject]);
  } finally {
    totals.matchMs += performance.now() - start;
    totals.calls += 1;
  }
};

process.on("exit", () => {
  writeFileSync(timingFile, JSON.stringify(totals));
});
