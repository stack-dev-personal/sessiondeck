import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED, BLOCKED, guardPath, repoRoot } from "./helpers/guard-run";
import {
  assertWithinBounds,
  GUARD_EXEC_COMMAND,
  matchesDeterministic,
  MAX_RAW_SCRIPT_MS,
  rowTimeoutMs,
  runTimed,
  rawMs,
  runTimedUntilWithin,
  violations,
  withinBounds,
  workMs,
} from "./helpers/guard-timing";

const fixtureDir = resolve(repoRoot, "scripts", "test", "fixtures", "guard-timing");
const fixturePath = resolve(fixtureDir, "regex-fixture.mjs");
const delayedReadPath = resolve(fixtureDir, "delayed-read-fixture.mjs");

describe("guard: adversarial timing (conductor decision 5)", () => {
  // Adversarial timing (security review, round 3): the hook has a 5 s timeout and a timeout lets the
  // command run, so matching in the guard must stay linear on long whitespace runs and paths.
  // The child runs with a preload (see helpers/guard-timing.ts) that records regex time (matchMs)
  // and time from preload to exit (scriptMs), so the bounds exclude node start-up and runner load.
  // Wall time is not a bound (it measures process start under load); the helper only kills a hang.
  // scriptMs also covers JSON.parse, `when` functions and hand-written loops, so a regex swapped
  // for a quadratic indexOf loop still fails. The guard's execSync (git rev-parse on bare pushes)
  // is input independent, so it is measured separately and subtracted. toLowerCase, includes and
  // String() are linear built-ins and stay inside scriptMs, which is the point.
  const MAX_MATCH_MS = 150;
  const MAX_SCRIPT_MS = 300;
  const RUN = 100_000;
  // Exact regex call counts. A command that reaches every rule runs the 7 plain RULES regexes (the
  // capture-install rule's `when` pre-check uses includes, so it adds regexes only when it passes)
  // plus the bare-push test: 8. A bare `git push` also runs the second push regex: 9. When the
  // pre-check passes, the capture-install rule searches for a node candidate. No candidate (the
  // quotes row) adds 1 and then the bare-push test runs: 9. A blocked command adds 2 (the candidate
  // and the --apply check) and exits before the bare-push test: 9. A candidate without --apply in
  // its segment adds 4 (candidate, flag check, segment end, final search) plus the bare-push test:
  // 12. A command blocked by the third push rule runs 3. Exact counts catch a refactor that drops
  // or skips a rule.
  const CALLS_ALL_RULES = 8;
  const CALLS_PLUS_ONE = 9;
  const CALLS_PUSH_MAIN = 3;
  const CALLS_CAPTURE_SKIPPED = 12;
  const BS = "\\";
  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  // Bare `git push` is blocked on main/master. CI pull_request runs check out a detached merge ref,
  // where the branch reads HEAD, so it is allowed there.
  const pushStatus = branch === "main" || branch === "master" ? BLOCKED : ALLOWED;
  interface TimingRow {
    readonly command: string;
    readonly calls: number;
    readonly status: number;
    readonly execCalls: number;
  }
  const row = (
    command: string,
    status: number,
    calls = CALLS_ALL_RULES,
    execCalls = 0,
  ): TimingRow => ({
    command,
    calls,
    status,
    execCalls,
  });
  // Shapes that scripts/test/guard-timing-growth.test.ts already runs at about 100k characters (the small
  // run of a growth row, same bounds, same exact call counts) are not repeated here: `git push ` x N,
  // `node --x=node ` x N + capture-install --apply, and the backslash-LF and backslash-CRLF
  // continuations with the flag in another segment.
  // Repeated-anchor rows repeat a rule's anchor (`git push `, `node `, ...) up to about 100k
  // characters. Before the FIX-2 guard patch several were quadratic (up to 12 s, past the 5 s hook
  // timeout, which Claude Code treats as allow). They are the rows after "quotes".
  const timingInputs: Record<string, TimingRow> = {
    spaces: row(" ".repeat(RUN), ALLOWED),
    tabs: row("\t".repeat(RUN), ALLOWED),
    newlines: row("\n".repeat(RUN), ALLOWED),
    "node + spaces + capture-install --apply": row(
      `node${" ".repeat(RUN)}scripts/capture-install.mjs --apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    "node + tabs + capture-install --apply": row(
      `node${"\t".repeat(RUN)}scripts/capture-install.mjs --apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    "node + long path": row(
      `node ${"a/".repeat(RUN / 2)}capture-install.mjs --apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    "git push + spaces": row(`git push${" ".repeat(RUN)}`, pushStatus, CALLS_PLUS_ONE, 1),
    "git push + tabs": row(`git push${"\t".repeat(RUN)}`, pushStatus, CALLS_PLUS_ONE, 1),
    quotes: row(`${'"'.repeat(RUN)} capture-install --apply`, ALLOWED, CALLS_PLUS_ONE),
    "git push - x N": row("git push -".repeat(10_000), ALLOWED, CALLS_PLUS_ONE),
    "git push origin x N + main": row(
      "git push origin ".repeat(6_250) + "main",
      BLOCKED,
      CALLS_PUSH_MAIN,
    ),
    "git branch x N": row("git branch ".repeat(9_000), ALLOWED),
    "git reset x N": row("git reset ".repeat(10_000), ALLOWED),
    "rm -rf x N": row("rm -rf ".repeat(14_000), ALLOWED),
    "rm - + r x N": row(`rm -${"r".repeat(RUN)}`, ALLOWED),
    "node x N + --apply capture-install": row(
      `${"node ".repeat(20_000)}--apply capture-install`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    "node capture-install.mjs x N + --apply": row(
      `${"node scripts/capture-install.mjs ".repeat(3_000)}--apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    "node -x x N, flag in another segment": row(
      `echo capture-install --apply; ${"node -x ".repeat(12_500)}`,
      ALLOWED,
      CALLS_PLUS_ONE,
    ),
    "node capture-install.mjs x N, flag in another segment": row(
      `echo --apply; ${"node scripts/capture-install.mjs ".repeat(3_000)}`,
      ALLOWED,
      CALLS_CAPTURE_SKIPPED,
    ),
    "braces x N + capture-install --apply": row(
      `${"{".repeat(RUN)} capture-install --apply`,
      ALLOWED,
      CALLS_PLUS_ONE,
    ),
    // Security review of the first patch: `--a` could be read as `--`+`a` or `-`+`-a`, so 33 options
    // gave 2^33 paths and the guard ran past the hook timeout (a timeout is an allow).
    "node + --a b x33, then a capture-install --apply segment": row(
      `node ${"--a b ".repeat(33)}; node scripts/capture-install.mjs --apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    "node + --a b x33 + node capture-install --apply, one segment": row(
      `node ${"--a b ".repeat(33)}node scripts/capture-install.mjs --apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
    // The same kind of ambiguity with an option value that ends in a backslash-newline continuation.
    "node + -a x backslash-newline x33 + node capture-install --apply": row(
      `node ${`-a x${BS}\n`.repeat(33)}node scripts/capture-install.mjs --apply`,
      BLOCKED,
      CALLS_PLUS_ONE,
    ),
  };
  // Async spawns only (no spawnSync), so concurrent tests do not stall each other's timers.
  // Each row runs until the first run is within both bounds, at most MAX_ATTEMPTS: it fails only if
  // all attempts violate a bound. Status and call-count mismatches are deterministic and fail on
  // the first attempt.
  it.concurrent.each(Object.entries(timingInputs))(
    `regex matching stays under ${MAX_MATCH_MS} ms and script under ${MAX_SCRIPT_MS} ms: %s`,
    async (name, expected) => {
      const bounds = { matchMs: MAX_MATCH_MS, workMs: MAX_SCRIPT_MS, rawMs: MAX_RAW_SCRIPT_MS };
      const { run, attempts, kills } = await runTimedUntilWithin(
        guardPath,
        expected.command,
        repoRoot,
        expected,
        bounds,
      );
      const scriptOnlyMs = workMs(run);
      console.info(
        `guard timing ${name}: attempts ${attempts}, kills ${kills}, ` +
          `match ${run.matchMs.toFixed(1)} ms (calls ${run.calls}), ` +
          `scriptMs ${run.scriptMs.toFixed(1)}, rawMs ${rawMs(run).toFixed(1)} (bound ${MAX_RAW_SCRIPT_MS}), stdinWaitMs ${run.stdinWaitMs.toFixed(1)}, ` +
          `stdinIdleMs ${run.stdinIdleMs.toFixed(1)}, workMs ${scriptOnlyMs.toFixed(1)}, ` +
          `execMs ${run.execMs.toFixed(1)}, ` +
          `execCalls ${run.execCalls}, wall ${run.wallMs.toFixed(0)} ms (not a bound), status ${run.status}`,
      );
      // Deterministic outputs first, so a mismatch is never read as a timing failure. execCommands
      // is pinned because execSync time is excluded from every bound: a slower exec must fail here.
      expect(run.status).toBe(expected.status);
      expect(run.calls).toBe(expected.calls);
      expect(run.execCalls).toBe(expected.execCalls);
      expect(run.execCommands).toEqual(Array(expected.execCalls).fill(GUARD_EXEC_COMMAND));
      expect(matchesDeterministic(run, expected)).toBe(true);
      // Bounds last: only this error lets the CI step run the file again (see scripts/ci).
      assertWithinBounds(run, bounds);
    },
    // A row makes one spawn per attempt, each waiting for a timing slot and killed at the hang limit.
    rowTimeoutMs(1),
  );

  // Self-test timeouts: a slow runner must not turn the QUADRATIC_RUN regex into a kill. The hang case
  // only needs the kill path, so it gets a short timeout.
  const SELF_TEST = { timeoutMs: 10_000 };
  const HANG_TIMEOUT_MS = 500;
  // The delay runs from the spawn, so the guard waits at most this long minus its start-up: under
  // the 3000 ms raw script bound, and the parent-side delay never reaches that bound.
  const STDIN_DELAY_MS = 2500;
  // Self-tests make at most two spawns, once each, and wait for a timing slot like the rows.
  const SELF_TEST_TIMEOUT_MS = rowTimeoutMs(2, 1);

  // Self-test of the instrumentation: a known quadratic regex and a slow hand loop must trip the
  // same bounds through the same helper, preload, stdin JSON and process.exit path, and a linear
  // control must not.
  it(
    "instrumentation detects a quadratic regex and keeps the exit status",
    async () => {
      const quadratic = await runTimed(fixturePath, "quadratic", repoRoot, SELF_TEST);
      console.info(
        `guard timing self-test quadratic: match ${quadratic.matchMs.toFixed(1)} ms (calls ${quadratic.calls})`,
      );
      expect(quadratic.matchMs).toBeGreaterThan(MAX_MATCH_MS);
      expect(quadratic.calls).toBeGreaterThanOrEqual(1);
      expect(quadratic.status).toBe(BLOCKED);
      const linear = await runTimed(fixturePath, "linear", repoRoot, SELF_TEST);
      console.info(
        `guard timing self-test linear: match ${linear.matchMs.toFixed(1)} ms (calls ${linear.calls})`,
      );
      expect(linear.matchMs).toBeLessThan(MAX_MATCH_MS);
      expect(linear.calls).toBeGreaterThanOrEqual(1);
      expect(linear.status).toBe(ALLOWED);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "instrumentation detects a slow hand-written loop through scriptMs",
    async () => {
      const slow = await runTimed(fixturePath, "slow-loop", repoRoot);
      expect(slow.matchMs).toBeLessThan(MAX_MATCH_MS);
      expect(workMs(slow)).toBeGreaterThan(MAX_SCRIPT_MS);
      expect(slow.status).toBe(ALLOWED);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "counts and excludes execSync through the named ESM import",
    async () => {
      const exec = await runTimed(fixturePath, "exec-sync", repoRoot);
      expect(exec.execCalls).toBe(1);
      expect(exec.execMs).toBeGreaterThan(0);
      expect(exec.scriptMs).toBeGreaterThanOrEqual(exec.execMs);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "pins the execSync command: a different command fails the deterministic check",
    async () => {
      const git = await runTimed(fixturePath, "exec-git", repoRoot);
      expect(git.execCommands).toEqual([GUARD_EXEC_COMMAND]);
      const wanted = { status: ALLOWED, calls: git.calls, execCalls: 1 };
      expect(matchesDeterministic(git, wanted)).toBe(true);
      const other = await runTimed(fixturePath, "exec-sync", repoRoot);
      expect(other.execCalls).toBe(1);
      expect(other.execCommands).toEqual(["node -e 0"]);
      expect(matchesDeterministic(other, { ...wanted, calls: other.calls })).toBe(false);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "catches sync work in an exit listener added after the preload's, without a retry",
    async () => {
      await expect(runTimed(fixturePath, "exit-listener", repoRoot)).rejects.toThrow(
        /exit listener/,
      );
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "reports a timeout kill as a kill, not as a missing timing file",
    async () => {
      await expect(
        runTimed(fixturePath, "hang", repoRoot, { timeoutMs: HANG_TIMEOUT_MS }),
      ).rejects.toThrow(/guard killed after/);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "subtracts the stdin wait set by the test process from the script time",
    async () => {
      const delayed = await runTimed(fixturePath, "linear", repoRoot, {
        timeoutMs: SELF_TEST.timeoutMs,
        stdinDelayMs: STDIN_DELAY_MS,
      });
      console.info(
        `guard timing self-test stdin delay: workMs ${workMs(delayed).toFixed(1)}, ` +
          `stdinWaitMs ${delayed.stdinWaitMs.toFixed(1)}, stdinIdleMs ${delayed.stdinIdleMs.toFixed(1)}`,
      );
      expect(delayed.stdinWaitMs).toBeGreaterThan(MAX_SCRIPT_MS);
      expect(delayed.scriptMs).toBeGreaterThan(MAX_SCRIPT_MS);
      expect(workMs(delayed)).toBeLessThan(MAX_SCRIPT_MS);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  // A guard that idles before it reads stdin (a timer, or an async exec awaited first) has almost no
  // workMs, because the idle part of the stdin window is subtracted, yet the real hook would run
  // that long and a timeout at 5 s allows the command. The raw time bound (rawMs) catches it.
  it.concurrent.each(["timer", "exec"])(
    "rejects a guard that idles before reading stdin through the raw time: %s",
    async (mode) => {
      const delayed = await runTimed(delayedReadPath, "linear", repoRoot, {
        timeoutMs: SELF_TEST.timeoutMs,
        scriptArgs: [mode],
      });
      const bounds = {
        matchMs: MAX_MATCH_MS,
        workMs: MAX_SCRIPT_MS,
        rawMs: MAX_RAW_SCRIPT_MS,
      };
      console.info(
        `guard timing self-test delayed read (${mode}): scriptMs ${delayed.scriptMs.toFixed(1)}, ` +
          `stdinIdleMs ${delayed.stdinIdleMs.toFixed(1)}, matchMs ${delayed.matchMs.toFixed(1)}, ` +
          `workMs ${workMs(delayed).toFixed(1)}, wall ${delayed.wallMs.toFixed(0)} ms, status ${delayed.status}`,
      );
      // The bounds that existed before see almost nothing, which is the hole: nearly all of the
      // script time is idle time that workMs subtracts.
      expect(delayed.matchMs).toBeLessThan(MAX_MATCH_MS);
      expect(workMs(delayed)).toBeLessThan(delayed.scriptMs / 2);
      expect(delayed.status).toBe(ALLOWED);
      expect(rawMs(delayed)).toBeGreaterThan(MAX_RAW_SCRIPT_MS);
      expect(withinBounds(delayed, bounds)).toBe(false);
      expect(violations(delayed, bounds)).toEqual([
        `rawMs ${rawMs(delayed).toFixed(1)} >= ${MAX_RAW_SCRIPT_MS}`,
      ]);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "counts CPU burned inside the stdin data handler (only idle wait is subtracted)",
    async () => {
      const hidden = await runTimed(fixturePath, "cpu-in-data", repoRoot);
      console.info(
        `guard timing self-test cpu-in-data: workMs ${workMs(hidden).toFixed(1)}, ` +
          `stdinWaitMs ${hidden.stdinWaitMs.toFixed(1)}, stdinIdleMs ${hidden.stdinIdleMs.toFixed(1)}`,
      );
      expect(hidden.matchMs).toBeLessThan(MAX_MATCH_MS);
      expect(workMs(hidden)).toBeGreaterThan(MAX_SCRIPT_MS);
      expect(hidden.status).toBe(ALLOWED);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it(
    "fails loudly when no timing file is written",
    async () => {
      await expect(runTimed(fixturePath, "skip-exit-handlers", repoRoot)).rejects.toThrow(
        /timing file/,
      );
    },
    SELF_TEST_TIMEOUT_MS,
  );
});
