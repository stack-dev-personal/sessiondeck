import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED, BLOCKED, guardPath, repoRoot } from "./helpers/guard-run";
import { MAX_WALL_MS, runTimed, runTimedUntilWithin, workMs } from "./helpers/guard-timing";

const fixturePath = resolve(
  repoRoot,
  "scripts",
  "test",
  "fixtures",
  "guard-timing",
  "regex-fixture.mjs",
);

describe("guard: adversarial timing (conductor decision 5)", () => {
  // Adversarial timing (security review, round 3): the hook has a 5 s timeout and a timeout lets the
  // command run, so matching in the guard must stay linear on long whitespace runs and paths.
  // The child runs with a preload (see helpers/guard-timing.ts) that records regex time (matchMs)
  // and time from preload to exit (scriptMs), so the bounds exclude node start-up and runner load.
  // scriptMs also covers JSON.parse, `when` functions and hand-written loops, so a regex swapped
  // for a quadratic indexOf loop still fails. The guard's execSync (git rev-parse on bare pushes)
  // is input independent, so it is measured separately and subtracted. toLowerCase, includes and
  // String() are linear built-ins and stay inside scriptMs, which is the point.
  const MAX_MATCH_MS = 150;
  const MAX_SCRIPT_MS = 300;
  const RUN = 100_000;
  // Exact regex call counts. A command that reaches every rule runs the 7 RULES regexes (the
  // capture-install rule's `when` pre-check uses includes, so it adds a regex only when it passes)
  // plus the bare-push test: 8. A bare `git push` also runs the second push regex: 9. The quotes
  // row passes the pre-check, runs the capture-install regex and then the bare-push test, which
  // makes 9 as measured. Exact counts catch a refactor that drops or skips a rule.
  const CALLS_ALL_RULES = 8;
  const CALLS_PLUS_ONE = 9;
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
  // Repeated-anchor rows (repeating the push anchor many times) are quadratic in guard.mjs today;
  // they land with the guard fix in docs/patches/FIX-2-guard.patch.
  const timingInputs: Record<string, TimingRow> = {
    spaces: row(" ".repeat(RUN), ALLOWED),
    tabs: row("\t".repeat(RUN), ALLOWED),
    newlines: row("\n".repeat(RUN), ALLOWED),
    "node + spaces + capture-install --apply": row(
      `node${" ".repeat(RUN)}scripts/capture-install.mjs --apply`,
      BLOCKED,
    ),
    "node + tabs + capture-install --apply": row(
      `node${"\t".repeat(RUN)}scripts/capture-install.mjs --apply`,
      BLOCKED,
    ),
    "node + long path": row(`node ${"a/".repeat(RUN / 2)}capture-install.mjs --apply`, BLOCKED),
    "git push + spaces": row(`git push${" ".repeat(RUN)}`, pushStatus, CALLS_PLUS_ONE, 1),
    "git push + tabs": row(`git push${"\t".repeat(RUN)}`, pushStatus, CALLS_PLUS_ONE, 1),
    quotes: row(`${'"'.repeat(RUN)} capture-install --apply`, ALLOWED, CALLS_PLUS_ONE),
  };
  // Async spawns only (no spawnSync), so concurrent tests do not stall each other's timers.
  // Each row runs until the first run is within both bounds, at most MAX_ATTEMPTS: it fails only if
  // all attempts violate a bound. Status and call-count mismatches are deterministic and fail on
  // the first attempt.
  it.concurrent.each(Object.entries(timingInputs))(
    `regex matching stays under ${MAX_MATCH_MS} ms and script under ${MAX_SCRIPT_MS} ms: %s`,
    async (name, expected) => {
      const { run, attempts, kills } = await runTimedUntilWithin(
        guardPath,
        expected.command,
        repoRoot,
        expected,
        { matchMs: MAX_MATCH_MS, workMs: MAX_SCRIPT_MS },
      );
      const scriptOnlyMs = workMs(run);
      console.info(
        `guard timing ${name}: attempts ${attempts}, kills ${kills}, ` +
          `match ${run.matchMs.toFixed(1)} ms (calls ${run.calls}), ` +
          `scriptMs ${run.scriptMs.toFixed(1)}, stdinWaitMs ${run.stdinWaitMs.toFixed(1)}, ` +
          `stdinIdleMs ${run.stdinIdleMs.toFixed(1)}, workMs ${scriptOnlyMs.toFixed(1)}, ` +
          `execMs ${run.execMs.toFixed(1)}, ` +
          `execCalls ${run.execCalls}, wall ${run.wallMs.toFixed(0)} ms, status ${run.status}`,
      );
      expect(run.matchMs).toBeLessThan(MAX_MATCH_MS);
      expect(scriptOnlyMs).toBeLessThan(MAX_SCRIPT_MS);
      expect(run.calls).toBe(expected.calls);
      expect(run.execCalls).toBe(expected.execCalls);
      expect(run.wallMs).toBeLessThan(MAX_WALL_MS);
      expect(run.status).toBe(expected.status);
    },
  );

  // Self-test timeouts: a slow runner must not turn the QUADRATIC_RUN regex into a kill. The hang case
  // only needs the kill path, so it gets a short timeout.
  const SELF_TEST = { timeoutMs: 10_000 };
  const HANG_TIMEOUT_MS = 500;
  const STDIN_DELAY_MS = 2500;

  // Self-test of the instrumentation: a known quadratic regex and a slow hand loop must trip the
  // same bounds through the same helper, preload, stdin JSON and process.exit path, and a linear
  // control must not.
  it("instrumentation detects a quadratic regex and keeps the exit status", async () => {
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
  });

  it("instrumentation detects a slow hand-written loop through scriptMs", async () => {
    const slow = await runTimed(fixturePath, "slow-loop", repoRoot);
    expect(slow.matchMs).toBeLessThan(MAX_MATCH_MS);
    expect(workMs(slow)).toBeGreaterThan(MAX_SCRIPT_MS);
    expect(slow.status).toBe(ALLOWED);
  });

  it("counts and excludes execSync through the named ESM import", async () => {
    const exec = await runTimed(fixturePath, "exec-sync", repoRoot);
    expect(exec.execCalls).toBe(1);
    expect(exec.execMs).toBeGreaterThan(0);
    expect(exec.scriptMs).toBeGreaterThanOrEqual(exec.execMs);
  });

  it("reports a timeout kill as a kill, not as a missing timing file", async () => {
    await expect(
      runTimed(fixturePath, "hang", repoRoot, { timeoutMs: HANG_TIMEOUT_MS }),
    ).rejects.toThrow(/guard killed after/);
  });

  it("subtracts the stdin wait set by the test process from the script time", async () => {
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
  });

  it("counts CPU burned inside the stdin data handler (only idle wait is subtracted)", async () => {
    const hidden = await runTimed(fixturePath, "cpu-in-data", repoRoot);
    console.info(
      `guard timing self-test cpu-in-data: workMs ${workMs(hidden).toFixed(1)}, ` +
        `stdinWaitMs ${hidden.stdinWaitMs.toFixed(1)}, stdinIdleMs ${hidden.stdinIdleMs.toFixed(1)}`,
    );
    expect(hidden.matchMs).toBeLessThan(MAX_MATCH_MS);
    expect(workMs(hidden)).toBeGreaterThan(MAX_SCRIPT_MS);
    expect(hidden.status).toBe(ALLOWED);
  });

  it("fails loudly when no timing file is written", async () => {
    await expect(runTimed(fixturePath, "skip-exit-handlers", repoRoot)).rejects.toThrow(
      /timing file/,
    );
  });
});
