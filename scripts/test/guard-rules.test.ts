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
    pick(blocked, 21), // cmd /c with quotes
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
