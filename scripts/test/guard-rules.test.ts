import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  BLOCKED,
  repoRoot,
  runGuard,
  runGuardProcess,
  runGuardProcessRaw,
  runGuardRaw,
  type GuardResult,
} from "./helpers/guard-run";

const BS = String.fromCharCode(92);

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
  // Concurrent: each row is one independent guard process; vitest caps the fan-out (maxConcurrency).
  it.concurrent.each(blocked)("blocks: %s", async (command) => {
    const { status, stderr } = await runGuard(command);
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
  it.concurrent.each(allowed)("allows: %s", async (command) => {
    expect((await runGuard(command)).status).toBe(ALLOWED);
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
  it.concurrent.each(knownFalsePositives)("known false positive (blocked): %s", async (command) => {
    expect((await runGuard(command)).status).toBe(BLOCKED);
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
    // FIX-2 guard patch: more than 32 options between node and the script is not recognised (the
    // option chain is capped so matching stays bounded; the old guard blocked this).
    `node ${"-r x ".repeat(40)}scripts/capture-install.mjs --apply`,
    // FIX-2 guard patch: the matcher is not quote aware. A `;` inside a quoted argument ends the
    // segment for the flag check, so the node line below is no longer matched (the old guard blocked
    // it only by luck; `node capture-install "a;b" --apply` is allowed by both guards).
    'node capture-install "x;)/node" capture-install --apply',
    'node capture-install "a;b" --apply',
  ];
  it.concurrent.each(knownGaps)("known gap (allowed): %s", async (command) => {
    expect((await runGuard(command)).status).toBe(ALLOWED);
  });

  // The tables above run the guard in a worker thread (helpers/guard-run.ts). The rows below run
  // it as a real node process, end to end: a blocked row (case-insensitive pre-check), an allowed
  // row, a non-Bash tool, and empty input.
  const nonBash = JSON.stringify({
    tool_name: "Read",
    tool_input: { command: "capture-install --apply" },
  });

  it("end to end (real process): blocks case-insensitively and allows a preview", async () => {
    const blockedRun = await runGuardProcess("NODE scripts/CAPTURE-INSTALL.mjs --APPLY");
    expect(blockedRun.status).toBe(BLOCKED);
    expect(blockedRun.stderr).toContain("capture-install --apply");
    expect((await runGuardProcess("node scripts/capture-install.mjs --dry-run")).status).toBe(
      ALLOWED,
    );
  });

  it("end to end (real process): ignores non-Bash tools and empty input", async () => {
    expect((await runGuardProcessRaw(nonBash)).status).toBe(ALLOWED);
    expect((await runGuardProcessRaw("")).status).toBe(ALLOWED);
  });

  // Parity of the worker runner with a real process: same exit status and same stderr, byte for byte.
  // A sample runs in every suite run; SD_GUARD_PARITY_ALL=1 runs every table row once (71 rows, two
  // runs each), which is how the worker runner was proven.
  const pick = (rows: readonly string[], index: number): string => {
    const row = rows[index];
    if (row === undefined) {
      throw new Error(`no table row at index ${index}`);
    }
    return row;
  };
  const sample = [
    pick(blocked, 0),
    pick(blocked, 16), // backslash-newline continuation
    pick(blocked, 11), // cmd /c with quotes
    pick(allowed, 10),
    pick(knownFalsePositives, 4), // backticks and quotes in the command
    pick(knownGaps, 5),
  ];
  const sameInBothRunners = async (input: string): Promise<GuardResult> => {
    const [viaWorker, viaProcess] = await Promise.all([
      runGuardRaw(input),
      runGuardProcessRaw(input),
    ]);
    expect(viaWorker).toEqual(viaProcess);
    return viaProcess;
  };

  it.concurrent.each(sample)("worker runner matches a real process: %s", async (command) => {
    const { status } = await sameInBothRunners(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repoRoot }),
    );
    expect(status).toBe(
      blocked.includes(command) || knownFalsePositives.includes(command) ? BLOCKED : ALLOWED,
    );
  });

  it("worker runner matches a real process: non-Bash tool, empty input, bad JSON", async () => {
    expect((await sameInBothRunners(nonBash)).status).toBe(ALLOWED);
    expect((await sameInBothRunners("")).status).toBe(ALLOWED);
    expect((await sameInBothRunners("{not json")).status).toBe(ALLOWED);
  });

  const BATCH = 8;
  it.skipIf(process.env.SD_GUARD_PARITY_ALL !== "1")(
    "worker runner matches a real process on every table row",
    async () => {
      const rows = [...blocked, ...allowed, ...knownFalsePositives, ...knownGaps];
      for (let i = 0; i < rows.length; i += BATCH) {
        await Promise.all(
          rows
            .slice(i, i + BATCH)
            .map((command) =>
              sameInBothRunners(
                JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repoRoot }),
              ),
            ),
        );
      }
      console.info(`guard runner parity: ${rows.length} table rows identical`);
    },
    300_000,
  );
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

// Functional push rows (R0.5, decision 13): status and message only, no timing. They stay in the
// default run so a regression in a push rule fails `pnpm -r test`; the timing rows live in the
// guard timing run.
describe("guard: git push rules (functional, no timing)", () => {
  const FORCE_MESSAGE = "force push is forbidden";
  const MAIN_MESSAGE = "pushing to main is forbidden";

  const blockedPushes: ReadonlyArray<readonly [string, string]> = [
    ["git push --force", FORCE_MESSAGE],
    ["git push -f", FORCE_MESSAGE],
    ["git push origin feature-x --force-with-lease", FORCE_MESSAGE],
    ["git push origin main", MAIN_MESSAGE],
    ["git push origin HEAD:main", MAIN_MESSAGE],
    ["git status; git push origin main", MAIN_MESSAGE],
  ];
  it.concurrent.each(blockedPushes)("blocks: %s", async (command, message) => {
    const { status, stderr } = await runGuard(command);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain(message);
  });

  it.concurrent("allows a push of a feature branch", async () => {
    expect((await runGuard("git push origin feature-x")).status).toBe(ALLOWED);
  });

  // A bare push sends the current branch: blocked on main or master, allowed on any other branch
  // and on a detached checkout (CI prints HEAD). The expectation is derived the way the guard
  // derives it, so the row holds on main, on a branch and on a detached CI checkout.
  it("bare push: blocked only when the checkout is on main or master", async () => {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim();
    const onMain = branch === "main" || branch === "master";
    const { status, stderr } = await runGuard("git push");
    expect(status).toBe(onMain ? BLOCKED : ALLOWED);
    if (onMain) {
      expect(stderr).toContain(`you are on ${branch}`);
    }
  });
});
