import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_WALL_MS, runTimed, runTimedBest } from "./helpers/guard-timing";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardPath = resolve(repoRoot, ".claude", "hooks", "guard.mjs");
const BLOCKED = 2;
const ALLOWED = 0;
const BS = String.fromCharCode(92);
const fixturePath = resolve(
  repoRoot,
  "scripts",
  "test",
  "fixtures",
  "guard-timing",
  "regex-fixture.mjs",
);

function runGuard(command: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd: repoRoot,
  });
  const result = spawnSync(process.execPath, [guardPath], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stderr: result.stderr };
}

describe("guard: capture-install --apply (conductor decision 5)", () => {
  const blocked = [
    "node scripts/capture-install.mjs --apply",
    "node C:/Users/someone/projects/sessiondeck/scripts/capture-install.mjs --apply",
    'node "scripts/capture-install.mjs" --apply',
    "node 'scripts/capture-install.mjs' '--apply'",
    "node.exe scripts/capture-install.mjs --apply",
    "node scripts/capture-install.mjs --out C:/tmp/x --apply",
    "node scripts/capture-install.mjs --uninstall --apply",
    "node scripts\\capture-install.mjs --apply",
    "node C:\\repo\\scripts\\capture-install.mjs --out D:\\cap --apply",
    "cd scripts && node capture-install.mjs --apply",
    "node scripts/capture-install --apply",
    'cmd /c "node scripts/capture-install.mjs --apply"',
    'powershell -c "node scripts/capture-install.mjs --apply"',
    "cmd /c node scripts/capture-install.mjs --apply",
    "echo $(node scripts/capture-install.mjs --apply)",
    "echo `node scripts/capture-install.mjs --apply`",
    `node scripts/capture-install.mjs ${BS}
  --apply`,
    `node ${BS}
  scripts/capture-install.mjs --apply`,
    "node --apply scripts/capture-install.mjs",
    "node --no-warnings scripts/capture-install.mjs --apply",
    "npx scripts/capture-install.mjs --apply",
    "git status; node scripts/capture-install.mjs --apply",
    "node scripts/capture-install.mjs '--apply'",
    "NODE scripts/CAPTURE-INSTALL.mjs --APPLY",
    // Workarounds a session might try after the first block (security review, iteration 2).
    "CLAUDECODE= node scripts/capture-install.mjs --apply",
    "env -u CLAUDECODE node scripts/capture-install.mjs --apply",
    "env X=1 node scripts/capture-install.mjs --apply",
    "X=1 node scripts/capture-install.mjs --apply",
    "NODE_OPTIONS=--no-warnings node scripts/capture-install.mjs --apply",
    "pnpm exec node scripts/capture-install.mjs --apply",
    "npm exec -- node scripts/capture-install.mjs --apply",
    "npx node scripts/capture-install.mjs --apply",
    "start node scripts/capture-install.mjs --apply",
    "nohup node scripts/capture-install.mjs --apply",
    "time node scripts/capture-install.mjs --apply",
    "exec node scripts/capture-install.mjs --apply",
    "xargs node scripts/capture-install.mjs --apply",
    "{ node scripts/capture-install.mjs --apply; }",
    "if true; then node scripts/capture-install.mjs --apply; fi",
    "for i in 1; do node scripts/capture-install.mjs --apply; done",
    '"C:/Program Files/nodejs/node.exe" scripts/capture-install.mjs --apply',
    '"node" scripts/capture-install.mjs --apply',
    "node -r ./x.mjs scripts/capture-install.mjs --apply",
    "node scripts/capture-install.mjs --apply>out.txt",
    "node scripts/capture-install.mjs --apply<in.txt",
  ];
  it.each(blocked)("blocks: %s", (command) => {
    const { status, stderr } = runGuard(command);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain("capture-install --apply");
  });

  const allowed = [
    "node scripts/capture-install.mjs",
    "node scripts/capture-install.mjs --dry-run",
    "node scripts/capture-install.mjs --uninstall",
    "node scripts/capture-install.mjs --uninstall --dry-run",
    "node scripts/capture-install.mjs --out C:/tmp/x",
    "node scripts/capture-install.mjs --dry-run && echo applied-later",
    "git status",
    'grep -rn "capture-install.mjs --apply" docs',
    'git log --grep="capture-install --apply"',
    "rg -- '--apply' scripts/capture-install.mjs",
    'git commit -m "docs: run capture-install --apply from a plain terminal"',
    "node scripts/capture-install.mjs --apply-later",
    "node scripts/capture-install.mjs --dry-run --apply-later",
    "node scripts/other.mjs --apply",
  ];
  it.each(allowed)("allows: %s", (command) => {
    expect(runGuard(command).status).toBe(ALLOWED);
  });

  // Known false positives (fail closed): a command that quotes the whole node line is blocked,
  // because a quote counts as an anchor. Documented, not fixed: telling a quoted mention from a
  // quoted command needs a shell parser, and a block is the safe side of the error.
  const knownFalsePositives = [
    "echo node scripts/capture-install.mjs --apply",
    'grep -n "node scripts/capture-install.mjs --apply" docs',
    'echo "node scripts/capture-install.mjs --apply"',
    'git commit -m x -m "node scripts/capture-install.mjs --apply is user-only"',
    'gh pr create --body "Run `node scripts/capture-install.mjs --apply` yourself"',
  ];
  it.each(knownFalsePositives)("known false positive (blocked): %s", (command) => {
    expect(runGuard(command).status).toBe(BLOCKED);
  });

  // Known gaps: the rule prevents accidents, not a hostile session. These forms are allowed. The
  // installer's own CLAUDECODE refusal and conductor decision 5 (a compromised session already has
  // the user's privileges) cover them; they are documented here, not treated as failures.
  const knownGaps = [
    "A=--apply; node scripts/capture-install.mjs $A",
    'node scripts/capture-install.mjs --ap""ply',
    'node scripts/capture-instal""l.mjs --apply',
    "node scripts/capture-insta*.mjs --apply",
    "cp scripts/capture-install.mjs x.mjs && node x.mjs --apply",
    "powershell -enc AAAA",
    "node -e \"import('./scripts/lib/install-cli.mjs')\"",
  ];
  it.each(knownGaps)("known gap (allowed): %s", (command) => {
    expect(runGuard(command).status).toBe(ALLOWED);
  });

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
  const REPEATS = 3;
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
  it.concurrent.each(Object.entries(timingInputs))(
    `regex matching stays under ${MAX_MATCH_MS} ms and script under ${MAX_SCRIPT_MS} ms: %s`,
    async (name, expected) => {
      const run = await runTimedBest(guardPath, expected.command, repoRoot, REPEATS);
      const scriptOnlyMs = run.scriptMs - run.execMs;
      console.info(
        `guard timing ${name}: match ${run.matchMs.toFixed(1)} ms (calls ${run.calls}), ` +
          `scriptMs ${run.scriptMs.toFixed(1)}, execMs ${run.execMs.toFixed(1)}, ` +
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

  // Self-test of the instrumentation: a known quadratic regex and a slow hand loop must trip the
  // same bounds through the same helper, preload, stdin JSON and process.exit path, and a linear
  // control must not.
  it("instrumentation detects a quadratic regex and keeps the exit status", async () => {
    const quadratic = await runTimed(fixturePath, "quadratic", repoRoot);
    console.info(
      `guard timing self-test quadratic: match ${quadratic.matchMs.toFixed(1)} ms (calls ${quadratic.calls})`,
    );
    expect(quadratic.matchMs).toBeGreaterThan(MAX_MATCH_MS);
    expect(quadratic.calls).toBeGreaterThanOrEqual(1);
    expect(quadratic.status).toBe(BLOCKED);
    const linear = await runTimed(fixturePath, "linear", repoRoot);
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
    expect(slow.scriptMs - slow.execMs).toBeGreaterThan(MAX_SCRIPT_MS);
    expect(slow.status).toBe(ALLOWED);
  });

  it("counts and excludes execSync through the named ESM import", async () => {
    const exec = await runTimed(fixturePath, "exec-sync", repoRoot);
    expect(exec.execCalls).toBe(1);
    expect(exec.execMs).toBeGreaterThan(0);
    expect(exec.scriptMs).toBeGreaterThanOrEqual(exec.execMs);
  });

  it.concurrent("reports a timeout kill as a kill, not as a missing timing file", async () => {
    await expect(runTimed(fixturePath, "hang", repoRoot)).rejects.toThrow(/guard killed after/);
  });

  it("fails loudly when no timing file is written", async () => {
    await expect(runTimed(fixturePath, "skip-exit-handlers", repoRoot)).rejects.toThrow(
      /timing file/,
    );
  });

  it("matches capture-install --apply case-insensitively in the pre-check", () => {
    expect(runGuard("NODE scripts/CAPTURE-INSTALL.mjs --APPLY").status).toBe(BLOCKED);
  });

  it("ignores non-Bash tools and empty input", () => {
    const other = spawnSync(process.execPath, [guardPath], {
      input: JSON.stringify({
        tool_name: "Read",
        tool_input: { command: "capture-install --apply" },
      }),
      encoding: "utf8",
    });
    expect(other.status).toBe(ALLOWED);
    const empty = spawnSync(process.execPath, [guardPath], {
      input: "",
      encoding: "utf8",
    });
    expect(empty.status).toBe(ALLOWED);
  });
});

describe(".claude/settings.json deny rules (conductor decision 5)", () => {
  const settings = JSON.parse(
    readFileSync(resolve(repoRoot, ".claude", "settings.json"), "utf8"),
  ) as {
    permissions: { deny: string[] };
  };

  it("denies Read of the capture directory in home-relative and absolute forms", () => {
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(~/AppData/Local/sessiondeck/capture/**)",
        "Read(//c/Users/*/AppData/Local/sessiondeck/capture/**)",
      ]),
    );
  });

  it("keeps the existing secret deny rules", () => {
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Read(./.env)", "Read(./.env.*)", "Read(./**/probe.json)"]),
    );
  });
});
