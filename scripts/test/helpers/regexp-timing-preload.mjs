// Preload for guard timing tests. Measures three things in a child process:
//  - matchMs/calls: time and count of regex matching. RegExp.prototype.test, match, replace, search
//    and split all call RegExp.prototype.exec, so one wrapper covers every regex call once.
//  - scriptMs: time from this preload finishing to process exit. Covers JSON.parse, `when`
//    functions and hand-written loops, and leaves out node start-up.
//  - stdinWaitMs: preload finishing to stdin `end`, recorded raw as evidence. null (never 0) when
//    `end` did not fire; the helper then throws.
//  - stdinIdleMs: event loop idle time inside that same window (performance.eventLoopUtilization
//    idle delta). How long the test process takes to write the input depends on parent load (spawn
//    blocks its event loop), not on the guard, and the guard's loop is idle while it waits. Tests
//    subtract only this idle part from scriptMs, so CPU the guard burns inside a stdin `data`
//    handler still counts.
//    Only an `end` listener is attached: no `data` listener and no resume(), so stdin flow for
//    the script is unchanged.
//  - execMs/execCalls: time and count of child_process.execSync (the guard's `git rev-parse`),
//    which is input independent and slow on loaded Windows. Tests subtract it from scriptMs.
// execSync is replaced on the builtin module object and syncBuiltinESMExports() republishes it, so
// a named ESM import (`import { execSync } from 'node:child_process'`) sees the wrapper. Tests
// assert execCalls to prove this took effect. execCommands holds the command string of each call,
// so tests can pin it to the guard's own git call.
//  - exitListeners: process.listenerCount("exit") when the exit listener below runs. Listeners the
//    guard adds are counted too; the helper rejects any count other than 1.
// On process exit (which also fires for process.exit) the totals are written as JSON to the file
// named by SD_GUARD_TIMING_FILE.
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const timingFile = process.env.SD_GUARD_TIMING_FILE;
if (!timingFile) {
  throw new Error("SD_GUARD_TIMING_FILE is not set");
}

/** @type {{ matchMs: number, calls: number, scriptMs: number, stdinWaitMs: number | null, stdinIdleMs: number, execMs: number, execCalls: number, execCommands: string[], exitListeners: number }} */
const totals = {
  execCommands: [],
  exitListeners: 0,
  matchMs: 0,
  calls: 0,
  scriptMs: 0,
  stdinWaitMs: null,
  stdinIdleMs: 0,
  execMs: 0,
  execCalls: 0,
};

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
  totals.execCommands.push(String(args[0]));
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
const eluStart = performance.eventLoopUtilization();
process.stdin.on("end", () => {
  totals.stdinWaitMs = performance.now() - scriptStart;
  totals.stdinIdleMs = performance.eventLoopUtilization(eluStart).idle;
});
process.on("exit", () => {
  totals.scriptMs = performance.now() - scriptStart;
  // This listener runs before any the guard adds later, so sync work in those is outside every
  // time above. The count (this listener is the one expected) lets the helper reject the run.
  totals.exitListeners = process.listenerCount("exit");
  writeFileSync(timingFile, JSON.stringify(totals));
});
