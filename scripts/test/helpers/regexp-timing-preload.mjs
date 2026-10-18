// Preload for guard timing tests. Measures three things in a child process:
//  - matchMs/calls: time and count of regex matching. RegExp.prototype.test, match, replace, search
//    and split all call RegExp.prototype.exec, so one wrapper covers every regex call once.
//  - scriptMs: time from this preload finishing to process exit. Covers JSON.parse, `when`
//    functions and hand-written loops, and leaves out node start-up.
//  - stdinWaitMs: preload finishing to stdin `end`. How long the test process takes to write the
//    input depends on parent load (spawn blocks its event loop), not on the guard, so tests
//    subtract it from scriptMs. null (never 0) when `end` did not fire; the helper then throws.
//    Only an `end` listener is attached: no `data` listener and no resume(), so stdin flow for
//    the script is unchanged.
//  - execMs/execCalls: time and count of child_process.execSync (the guard's `git rev-parse`),
//    which is input independent and slow on loaded Windows. Tests subtract it from scriptMs.
// execSync is replaced on the builtin module object and syncBuiltinESMExports() republishes it, so
// a named ESM import (`import { execSync } from 'node:child_process'`) sees the wrapper. Tests
// assert execCalls to prove this took effect.
// On process exit (which also fires for process.exit) the totals are written as JSON to the file
// named by SD_GUARD_TIMING_FILE.
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const timingFile = process.env.SD_GUARD_TIMING_FILE;
if (!timingFile) {
  throw new Error("SD_GUARD_TIMING_FILE is not set");
}

/** @type {{ matchMs: number, calls: number, scriptMs: number, stdinWaitMs: number | null, execMs: number, execCalls: number }} */
const totals = { matchMs: 0, calls: 0, scriptMs: 0, stdinWaitMs: null, execMs: 0, execCalls: 0 };

const originalExec = RegExp.prototype.exec;
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

const originalExecSync = childProcess.execSync;
/**
 * @this {unknown}
 * @param {...unknown} args
 */
function timedExecSync(...args) {
  const start = performance.now();
  try {
    return Reflect.apply(originalExecSync, this, args);
  } finally {
    totals.execMs += performance.now() - start;
    totals.execCalls += 1;
  }
}
/** @type {any} */ (childProcess).execSync = timedExecSync;
syncBuiltinESMExports();

const scriptStart = performance.now();
process.stdin.on("end", () => {
  totals.stdinWaitMs = performance.now() - scriptStart;
});
process.on("exit", () => {
  totals.scriptMs = performance.now() - scriptStart;
  writeFileSync(timingFile, JSON.stringify(totals));
});
