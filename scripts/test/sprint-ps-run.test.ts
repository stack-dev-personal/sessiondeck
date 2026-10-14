import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BatchResult,
  dockerForm,
  makeNodeOnlyDir,
  makeWorkspace,
  runArgs,
  runBatch,
  RUN_SPRINT,
  SENTINEL,
  SHELL,
  SKIP_REASON,
  SPRINT_SCRIPTS,
  type Workspace,
} from "./fixtures/sprint-ps/harness";
import { cleanupTempDirs } from "./helpers";

afterAll(cleanupTempDirs);

const STATE_SUBDIRS = [
  "answers",
  "gate",
  "logs",
  "prompts",
  "questions",
  "reports",
  "screens",
  "sessions",
];
const SMOKE_PROMPT = "write /state/smoke/status.json with state green and exit\n";
const SHA = "abc1234";
const REPO_URL = "https://example.invalid/owner/repo.git";
const BAD_IDS = ["..", "a/b", "", "-x", "a b", "ok\nx"];

function packageBranch(sprint: string): string {
  const r = spawnSync(
    process.execPath,
    [join(SPRINT_SCRIPTS, "render-prompt.mjs"), "--sprint", sprint, "--package-json"],
    { encoding: "utf8" },
  );
  return (JSON.parse(r.stdout) as { branch: string | null }).branch ?? "";
}

if (SHELL === undefined) console.warn(`SKIPPED: ${SKIP_REASON}`);

describe.skipIf(SHELL === undefined)("run-sprint.ps1 (fake docker on PATH)", () => {
  let ws: Workspace;
  let batch: BatchResult;
  const run = (i: number) => batch.runs[i]!;
  const callsFor = (name: string, key: string) =>
    batch.calls.filter((c) => c.name === name && c.key === key);

  beforeAll(() => {
    ws = makeWorkspace();
    // Sprint 2 has run before: a status file, a stale prompt, and a file that must survive -Resume.
    const two = join(ws.state, "2");
    mkdirSync(two);
    writeFileSync(join(two, "status.json"), '{"state":"running"}');
    writeFileSync(join(two, "keep.txt"), "kept");
    writeFileSync(join(two, "sprint-prompt.md"), "stale");

    const missingEnv = join(ws.state, "..", "nowhere", "envfile.txt");
    const lists: string[][] = [
      ...BAD_IDS.map((id) => runArgs(ws, id)), // 0-5
      [
        "-Sprint",
        "smoke",
        "-RepoRoot",
        ws.repo,
        "-StateRoot",
        ws.state,
        "-EnvFile",
        missingEnv,
        "-RepoUrl",
        REPO_URL,
      ], // 6
      runArgs(ws, "7"), // 7
      runArgs(ws, "1"), // 8
      runArgs(ws, "1", ["-ContractSha", "bad sha!"]), // 9
      runArgs(ws, "0"), // 10
      runArgs(ws, "smoke"), // 11
      runArgs(ws, "2", ["-ContractSha", SHA]), // 12
      runArgs(ws, "3", ["-Resume", "-ContractSha", SHA]), // 13
      runArgs(ws, "2", ["-Resume", "-ContractSha", SHA]), // 14
      runArgs(ws, "4", ["-ContractSha", SHA]), // 15
      runArgs(ws, "5", ["-ContractSha", SHA]), // 16
      runArgs(ws, "1", ["-ContractSha", SHA]), // 17
      runArgs(ws, "smoke", ["-DryRun"]), // 18
    ];
    batch = runBatch(ws, RUN_SPRINT, lists, {
      plan: {
        "ps:sprint-1": { code: 1 },
        "ps:sprint-4": { out: "sprint-4" },
        "ps:sprint-5": { out: "sprint-50\nsprint-5x" },
        "up:sprint-5": { code: 7 },
      },
    });
  }, 120_000);

  it("rejects bad ids with exit 2 naming the rule, before any docker call", () => {
    BAD_IDS.forEach((_, i) => {
      expect(run(i).code, `case ${i}`).toBe(2);
      expect(run(i).stderr).toContain("letters, digits, hyphen and underscore");
    });
    expect(batch.calls.filter((c) => c.name === null || /-\./.test(c.name ?? ""))).toEqual([]);
    expect(readdirSync(ws.state).sort()).toEqual(["0", "2", "5", "smoke"]);
  });

  it("names a missing env file with exit 3", () => {
    expect(run(6).code).toBe(3);
    expect(run(6).stderr).toContain("env file");
    expect(run(6).stderr).toContain("envfile.txt");
  });

  it("stops with the renderer's message on unknown sprint or missing sha", () => {
    expect(run(7).code).toBe(2);
    expect(run(7).stderr).toContain("unknown sprint");
    expect(run(8).code).toBe(2);
    expect(run(8).stderr).toContain("--contract-sha");
    expect(run(9).code).toBe(2);
    expect(existsSync(join(ws.state, "7"))).toBe(false);
  });

  it("starts sprint 0: layout, rendered prompt, and the recorded compose call", () => {
    expect(run(10).code, run(10).stderr).toBe(0);
    const dir = join(ws.state, "0");
    expect(readdirSync(dir).sort()).toEqual([...STATE_SUBDIRS, "sprint-prompt.md"].sort());
    expect(existsSync(join(dir, "status.json"))).toBe(false);
    const prompt = readFileSync(join(dir, "sprint-prompt.md"), "utf8");
    expect(prompt).toContain("sprint/0-bootstrap");
    expect(prompt.includes("\r")).toBe(false);

    const [up] = callsFor("sprint-0", "up");
    expect(up!.argv).toEqual([
      "compose",
      "-p",
      "sprint-0",
      "-f",
      dockerForm(join(ws.repo, "infra", "sprint", "docker-compose.yml")),
      "up",
      "-d",
    ]);
    expect(up!.env).toEqual({
      SPRINT_ID: "0",
      SPRINT_BRANCH: packageBranch("0"),
      SPRINT_REPO_URL: REPO_URL,
      SPRINT_ENV_FILE: dockerForm(ws.envFile),
      SPRINT_STATE_ROOT: dockerForm(ws.state),
    });
    expect(up!.secretNames).toEqual([]);
    expect(callsFor("sprint-0", "ps")).toHaveLength(1);
  });

  it("renders the one-line smoke prompt and starts with an empty branch", () => {
    expect(run(11).code, run(11).stderr).toBe(0);
    expect(readFileSync(join(ws.state, "smoke", "sprint-prompt.md"), "utf8")).toBe(SMOKE_PROMPT);
    const [up] = callsFor("sprint-smoke", "up");
    expect(up!.env.SPRINT_ID).toBe("smoke");
    expect(up!.env.SPRINT_BRANCH ?? "").toBe("");
  });

  it("refuses without -Resume when status.json exists, and without a state dir when resuming", () => {
    expect(run(12).code).toBe(4);
    expect(run(12).stderr).toContain("-Resume");
    expect(run(13).code).toBe(4);
    expect(existsSync(join(ws.state, "3"))).toBe(false);
    expect(callsFor("sprint-2", "up")).toHaveLength(1); // only the -Resume run reached docker
  });

  it("-Resume keeps the state dir, re-renders the prompt, and recreates the container", () => {
    expect(run(14).code, run(14).stderr).toBe(0);
    const dir = join(ws.state, "2");
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("kept");
    expect(readFileSync(join(dir, "status.json"), "utf8")).toBe('{"state":"running"}');
    expect(readFileSync(join(dir, "sprint-prompt.md"), "utf8")).toContain("sprint/2-");
    expect(callsFor("sprint-2", "up")[0]!.argv.slice(-3)).toEqual(["up", "-d", "--force-recreate"]);
  });

  it("refuses to start over a running container and points at stop-sprint", () => {
    expect(run(15).code).toBe(4);
    expect(run(15).stderr).toContain("stop-sprint.ps1");
    expect(callsFor("sprint-4", "up")).toHaveLength(0);
    expect(existsSync(join(ws.state, "4"))).toBe(false);
  });

  it("maps docker failures to exit 5 and ignores look-alike container names", () => {
    // sprint-50 and sprint-5x are running, sprint-5 is not, so the start was attempted and failed.
    expect(run(16).code).toBe(5);
    expect(callsFor("sprint-5", "up")).toHaveLength(1);
    expect(run(17).code).toBe(5);
    expect(run(17).stderr).toContain("docker ps failed");
    expect(callsFor("sprint-1", "up")).toHaveLength(0);
  });

  it("-DryRun prints the command and variables and makes no state-changing docker call", () => {
    const out = run(18).stdout;
    expect(run(18).code).toBe(0);
    expect(out).toContain("would run: docker compose -p sprint-smoke -f ");
    expect(out).toContain("up -d");
    expect(out).toContain("SPRINT_ID=smoke");
    expect(out).toContain(`SPRINT_ENV_FILE=${dockerForm(ws.envFile)}`);
    expect(out).toContain(`SPRINT_STATE_ROOT=${dockerForm(ws.state)}`);
    expect(callsFor("sprint-smoke", "up")).toHaveLength(1); // the real start in case 11 only
    expect(callsFor("sprint-smoke", "ps")).toHaveLength(2);
  });

  it("never reads the env file: the sentinel is in no output, argv or recorded variable", () => {
    const everything = JSON.stringify([batch.stdout, batch.stderr, batch.calls]);
    expect(everything).not.toContain(SENTINEL);
    for (const call of batch.calls) {
      expect(call.secretNames).toEqual([]);
      expect(call.argv.join(" ")).not.toMatch(/token|--env-file/i);
    }
  });

  it("only ever issues read-only queries plus the one compose up per start", () => {
    const keys = new Set(batch.calls.map((c) => c.key));
    expect([...keys].sort()).toEqual(["ps", "up"]);
    const withDocker = batch.calls.flatMap((c) => c.argv);
    expect(withDocker).not.toContain("build");
    expect(withDocker).not.toContain("--build");
  });
});

describe.skipIf(SHELL === undefined)("run-sprint.ps1 prerequisites", () => {
  it("names docker as missing when only node is on PATH, exit 3", () => {
    const ws = makeWorkspace();
    const result = runBatch(ws, RUN_SPRINT, [runArgs(ws, "smoke")], {
      onlyPath: makeNodeOnlyDir(),
    });
    const only = result.runs[0]!;
    expect(only.code).toBe(3);
    expect(only.stderr).toContain("docker (not on PATH)");
    expect(only.stderr).not.toContain("node (not on PATH)");
    expect(result.calls).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")(
    "warns with the principal names, never content, when the env file is readable by Everyone",
    () => {
      const ws = makeWorkspace();
      const icacls = spawnSync("icacls", [ws.envFile, "/grant", "*S-1-1-0:R"], {
        encoding: "utf8",
      });
      expect(icacls.status).toBe(0);
      const r = runBatch(ws, RUN_SPRINT, [runArgs(ws, "smoke", ["-DryRun"])]).runs[0]!;
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("warning: the env file can be read by more than you");
      expect(r.stderr + r.stdout).not.toContain(SENTINEL);
    },
  );
});
