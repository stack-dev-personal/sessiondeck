import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BatchResult,
  type DockerPlan,
  makeWorkspace,
  runBatch,
  SHELL,
  SKIP_REASON,
  SMOKE_CHECK,
  type Workspace,
} from "./fixtures/sprint-ps/harness";
import { cleanupTempDirs } from "./helpers";

afterAll(cleanupTempDirs);

if (SHELL === undefined) console.warn(`SKIPPED: ${SKIP_REASON}`);

// Each beforeAll starts PowerShell and waits for several polls.
const HOOK_TIMEOUT_MS = 120_000;
const POLL = ["-PollSeconds", "1"];
const GREEN = '{"state":"green"}';
const ESC = String.fromCharCode(0x1b);
const CSI_C1 = String.fromCharCode(0x9b);
// OSC 52 clipboard write, a cursor move, a C1 CSI and non-ASCII text.
const HOSTILE = `${ESC}]52;c;QUJD${String.fromCharCode(7)}${ESC}[2A${CSI_C1}31m caf\u00e9 \u2603`;
const ASCII_ONLY = /^[\x20-\x7e\r\n]*$/;

const statusPath = (ws: Workspace) => join(ws.state, "smoke", "status.json");
const logPath = (ws: Workspace) => join(ws.state, "smoke", "logs", "entrypoint.log");
const running = (extra: object = {}) => ({ out: "running 0", ...extra });
const callsFor = (batch: BatchResult, key: string) =>
  batch.calls.filter((c) => c.key === key && c.name === "sprint-smoke");

/** Plan entries that let stop-sprint find and remove the smoke container. */
const stoppable: DockerPlan = { "ps-a:sprint-smoke": { out: "sprint-smoke" } };

function seedLog(ws: Workspace, lines: string[]): void {
  mkdirSync(join(ws.state, "smoke", "logs"), { recursive: true });
  writeFileSync(logPath(ws), `${lines.join("\n")}\n`);
}

describe.skipIf(SHELL === undefined)("smoke-check.ps1 PASS path (fake docker on PATH)", () => {
  let ws: Workspace;
  let batch: BatchResult;
  const evidenceFile = () => join(ws.state, "..", "evidence.txt");

  beforeAll(() => {
    ws = makeWorkspace();
    seedLog(ws, ["start: sprint=smoke", `leak ${HOSTILE}`, "clone path: cloning"]);
    batch = runBatch(
      ws,
      SMOKE_CHECK,
      [
        [
          "-StateRoot",
          ws.state,
          "-EnvFile",
          ws.envFile,
          "-RepoRoot",
          ws.repo,
          "-TimeoutSeconds",
          "60",
          ...POLL,
          "-EvidenceFile",
          evidenceFile(),
        ],
        // The first run left a green status.json behind: the second must clear it, not stop on exit 4.
        [
          "-StateRoot",
          ws.state,
          "-EnvFile",
          ws.envFile,
          "-RepoRoot",
          ws.repo,
          "-KeepContainer",
          ...POLL,
        ],
      ],
      {
        plan: {
          ...stoppable,
          // Two polls see a running container with no status file; the third poll sees green.
          "container:sprint-smoke": {
            seq: [
              running(),
              running(),
              running({ writeFile: { path: statusPath(ws), content: GREEN } }),
            ],
          },
        },
      },
    );
  }, HOOK_TIMEOUT_MS);

  it("passes when the status file turns green after a delay", () => {
    const run = batch.runs[0]!;
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("RESULT: PASS");
    expect(run.stdout).toContain("final_state: green");
    expect(run.stdout).toMatch(/elapsed_seconds: \d+\.\d \(limit 60\)/);
    expect(callsFor(batch, "container").length).toBeGreaterThanOrEqual(3);
  });

  it("starts the smoke sprint through run-sprint with the given env file and state root", () => {
    const up = batch.calls.find((c) => c.key === "up")!;
    expect(up.env.SPRINT_ID).toBe("smoke");
    expect(up.env.SPRINT_STATE_ROOT).toBe(ws.state.replace(/\\/g, "/"));
    expect(up.env.SPRINT_ENV_FILE).toBe(ws.envFile.replace(/\\/g, "/"));
  });

  it("stops the container at the end, and not with -KeepContainer", () => {
    expect(batch.runs[0]!.stdout).toContain("stop-sprint: ran, exit 0");
    expect(callsFor(batch, "stop")).toHaveLength(1);
    expect(batch.runs[1]!.stdout).toContain("stop-sprint: skipped (-KeepContainer)");
  });

  it("clears the previous smoke status file instead of failing on it", () => {
    expect(batch.runs[1]!.code).toBe(0);
    expect(batch.runs[1]!.stdout).toContain("removed the previous");
  });

  it("prints the log tail as printable ASCII with the secrets reminder", () => {
    const out = batch.runs[0]!.stdout;
    expect(out).toContain("clone path: cloning");
    expect(out).toContain("can hold secrets");
    expect(out).toMatch(ASCII_ONLY);
    expect(out).not.toContain("QUJD".repeat(2));
  });

  it("saves the same evidence block to -EvidenceFile", () => {
    const saved = readFileSync(evidenceFile(), "utf8");
    expect(saved).toContain("RESULT: PASS");
    expect(saved).toMatch(ASCII_ONLY);
    expect(saved).not.toContain("\r");
    expect(batch.runs[0]!.stdout).toContain(saved.trim());
  });

  it("never prints the env file content or passes tokens to docker", () => {
    expect(batch.stdout + batch.stderr).not.toContain("SENTINEL");
    for (const call of batch.calls) {
      expect(call.argv.join(" ")).not.toContain("SENTINEL");
    }
  });
});

describe.skipIf(SHELL === undefined)("smoke-check.ps1 FAIL paths", () => {
  let ws: Workspace;
  let batch: BatchResult;
  let exitedWs: Workspace;
  let exited: BatchResult;

  beforeAll(() => {
    ws = makeWorkspace();
    seedLog(
      ws,
      Array.from({ length: 30 }, (_, i) => `line-${i} ${HOSTILE}`),
    );
    // The "container" writes a hostile status file on start; it never turns green.
    batch = runBatch(
      ws,
      SMOKE_CHECK,
      [
        [
          "-StateRoot",
          ws.state,
          "-EnvFile",
          ws.envFile,
          "-RepoRoot",
          ws.repo,
          "-TimeoutSeconds",
          "3",
          ...POLL,
        ],
      ],
      {
        plan: {
          ...stoppable,
          up: {
            writeFile: {
              path: statusPath(ws),
              content: JSON.stringify({ state: `${HOSTILE}green`, pr: HOSTILE }),
            },
          },
          "container:sprint-smoke": running(),
        },
      },
    );

    exitedWs = makeWorkspace();
    exited = runBatch(
      exitedWs,
      SMOKE_CHECK,
      [
        [
          "-StateRoot",
          exitedWs.state,
          "-EnvFile",
          exitedWs.envFile,
          "-RepoRoot",
          exitedWs.repo,
          "-TimeoutSeconds",
          "60",
          "-KeepContainer",
          ...POLL,
        ],
      ],
      { plan: { ...stoppable, "container:sprint-smoke": { out: "exited 128" } } },
    );
  }, HOOK_TIMEOUT_MS);

  it("fails with exit 1 on timeout and still stops the container", () => {
    const run = batch.runs[0]!;
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("RESULT: FAIL");
    expect(run.stdout).toContain("container: running");
    expect(callsFor(batch, "stop")).toHaveLength(1);
  });

  it("shows a hostile state as invalid and strips control characters everywhere", () => {
    const out = batch.runs[0]!.stdout;
    expect(out).toContain("final_state: invalid");
    expect(out).toMatch(ASCII_ONLY);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("caf\u00e9");
  });

  it("prints only the last 20 log lines", () => {
    const out = batch.runs[0]!.stdout;
    expect(out).toContain("line-29");
    expect(out).toContain("line-10");
    expect(out).not.toContain("line-9 ");
  });

  it("fails early with the exit code when the container exits, and keeps it with -KeepContainer", () => {
    const run = exited.runs[0]!;
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("container: exited, exit code 128");
    expect(run.stdout).toContain("final_state: no status.json");
    expect(run.stdout).toContain("(no entrypoint.log on the host side)");
    expect(callsFor(exited, "stop")).toHaveLength(0);
    expect(existsSync(statusPath(exitedWs))).toBe(false);
  });
});

describe.skipIf(SHELL === undefined)("smoke-check.ps1 run-sprint failures", () => {
  let ws: Workspace;
  let batch: BatchResult;

  beforeAll(() => {
    ws = makeWorkspace();
    batch = runBatch(
      ws,
      SMOKE_CHECK,
      [
        ["-StateRoot", ws.state, "-EnvFile", ws.envFile, "-RepoRoot", ws.repo, ...POLL], // docker up fails
        ["-StateRoot", ws.state, "-EnvFile", join(ws.state, "missing-file"), "-RepoRoot", ws.repo], // exit 3
      ],
      { plan: { ...stoppable, up: { code: 1 } } },
    );
  }, HOOK_TIMEOUT_MS);

  it("passes the run-sprint exit code through (docker failure is 5) and cleans up", () => {
    const run = batch.runs[0]!;
    expect(run.code).toBe(5);
    expect(run.stdout).toContain("RESULT: FAIL");
    expect(run.stdout).toContain("run-sprint exit: 5");
    expect(run.stdout).toContain("stop-sprint: ran");
  });

  it("passes a prerequisite failure through (3) without stopping anything", () => {
    const run = batch.runs[1]!;
    expect(run.code).toBe(3);
    expect(run.stdout).toContain("stop-sprint: skipped (run-sprint did not start a container)");
    expect(run.stderr).toContain("missing prerequisites");
    expect(callsFor(batch, "stop")).toHaveLength(1);
  });
});
