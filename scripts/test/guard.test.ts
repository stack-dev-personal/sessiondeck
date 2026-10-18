import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardPath = resolve(repoRoot, ".claude", "hooks", "guard.mjs");
const BLOCKED = 2;
const ALLOWED = 0;
const BS = String.fromCharCode(92);

function runGuard(command: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd: repoRoot,
  });
  const result = spawnSync(process.execPath, [guardPath], {
    input,
    encoding: "utf8",
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
  // command run, so every call to the whole guard must stay fast on long whitespace runs and paths.
  const MAX_GUARD_MS = 200;
  const RUN = 10_000;
  const timingInputs: Record<string, string> = {
    spaces: " ".repeat(RUN),
    tabs: "\t".repeat(RUN),
    newlines: "\n".repeat(RUN),
    "node + spaces + capture-install --apply": `node${" ".repeat(RUN)}scripts/capture-install.mjs --apply`,
    "node + tabs + capture-install --apply": `node${"\t".repeat(RUN)}scripts/capture-install.mjs --apply`,
    "node + long path": `node ${"a/".repeat(5000)}capture-install.mjs --apply`,
    "git push + spaces": `git push${" ".repeat(RUN)}`,
    "git push + tabs": `git push${"\t".repeat(RUN)}`,
    quotes: `${'"'.repeat(RUN)} capture-install --apply`,
  };
  it.each(Object.entries(timingInputs))("finishes under 200 ms: %s", (_name, command) => {
    const start = performance.now();
    runGuard(command);
    const elapsed = performance.now() - start;
    console.info(`guard timing ${_name}: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(MAX_GUARD_MS);
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
