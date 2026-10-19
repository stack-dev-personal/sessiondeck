import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BatchResult,
  CANARY,
  type DockerPlan,
  linkDir,
  makeLinkTarget,
  makeWorkspace,
  runBatch,
  SHELL,
  SKIP_REASON,
  SMOKE_CHECK,
  tryLinkFile,
  type Workspace,
} from "./fixtures/sprint-ps/harness";
import { cleanupTempDirs } from "./helpers";

afterAll(cleanupTempDirs);

if (SHELL === undefined) console.warn(`SKIPPED: ${SKIP_REASON}`);

// Each beforeAll starts PowerShell and waits for several polls.
const HOOK_TIMEOUT_MS = 120_000;
const POLL = ["-PollSeconds", "1"];
const GREEN = '{"state":"green"}';
const IMAGE = "sessiondeck-sprint:local";
// run-sprint (an image build, in real life) takes longer than the whole wait limit below.
const SLOW_START_MS = 4000;
const SHORT_LIMIT_SECONDS = "6";
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
          [`image-inspect:${IMAGE}`]: { out: "sha256:feedbeef created 2026-10-01T00:00:00Z" },
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
    expect(run.stdout).toMatch(
      /wait_seconds: \d+\.\d \(limit 60, counted after run-sprint returned\)/,
    );
    expect(run.stdout).toMatch(/start_seconds: \d+\.\d /);
    expect(run.stdout).toContain("present (reused, no build)");
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

describe.skipIf(SHELL === undefined)("smoke-check.ps1 wait clock", () => {
  let ws: Workspace;
  let batch: BatchResult;

  beforeAll(() => {
    ws = makeWorkspace();
    // The image is missing and compose "builds" it for longer than the wait limit; the session
    // turns green on the third poll, which is still inside the limit once the clock starts late.
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
          SHORT_LIMIT_SECONDS,
          ...POLL,
        ],
      ],
      {
        plan: {
          ...stoppable,
          [`image-inspect:${IMAGE}`]: {
            code: 1,
            err: `Error response from daemon: No such image: ${IMAGE}`,
          },
          up: { delayMs: SLOW_START_MS },
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

  it("starts the wait clock after run-sprint returns, so a slow start does not time out the wait", () => {
    const run = batch.runs[0]!;
    expect(run.code, run.stdout).toBe(0);
    expect(run.stdout).toContain("RESULT: PASS");
    expect(run.stdout).toMatch(/start_seconds: [4-9]\.\d /);
    expect(run.stdout).toMatch(/wait_seconds: [2-5]\.\d \(limit 6,/);
  });

  it("says a build happened when the image was missing", () => {
    expect(batch.runs[0]!.stdout).toContain(
      `image ${IMAGE}: missing before the start: compose built it`,
    );
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
    expect(run.stdout).toContain("missing; run-sprint did not start, nothing was built");
  });

  it("passes a prerequisite failure through (3) without stopping anything", () => {
    const run = batch.runs[1]!;
    expect(run.code).toBe(3);
    expect(run.stdout).toContain("stop-sprint: skipped (run-sprint did not start a container)");
    expect(run.stdout).toContain("missing; run-sprint did not start, nothing was built");
    expect(run.stdout).not.toContain("compose built it");
    expect(run.stderr).toContain("missing prerequisites");
    expect(callsFor(batch, "stop")).toHaveLength(1);
  });
});

describe.skipIf(SHELL === undefined)("smoke-check.ps1 asks about the docker target first", () => {
  it("exits 3 naming DOCKER_HOST, before any image query, when the target is remote", () => {
    const ws = makeWorkspace();
    const batch = runBatch(
      ws,
      SMOKE_CHECK,
      [["-StateRoot", ws.state, "-EnvFile", ws.envFile, "-RepoRoot", ws.repo, ...POLL]],
      {
        // Without the early check the image query fails with exit 5 ("is Docker running?").
        plan: {
          [`image-inspect:${IMAGE}`]: { code: 1, err: "Cannot connect to the Docker daemon" },
        },
        env: { DOCKER_HOST: "tcp://hub-box:2375" },
      },
    );
    const run = batch.runs[0]!;
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("smoke-check: DOCKER_HOST is set");
    expect(run.stderr).not.toContain("hub-box");
    expect(batch.calls.filter((c) => c.key === "image-inspect")).toHaveLength(0);
  });
});

describe.skipIf(SHELL === undefined)(
  "smoke-check.ps1 refuses links planted in the state directory",
  () => {
    const everything = (b: BatchResult) => b.stdout + b.stderr;
    const smokeDir = (ws: Workspace) => join(ws.state, "smoke");

    it("refuses a smoke directory that is a link before deleting anything, and prints nothing from behind it", () => {
      const ws = makeWorkspace();
      const target = makeLinkTarget(ws);
      linkDir(target, smokeDir(ws));
      const batch = runBatch(ws, SMOKE_CHECK, [
        ["-StateRoot", ws.state, "-EnvFile", ws.envFile, "-RepoRoot", ws.repo, ...POLL],
      ]);
      const run = batch.runs[0]!;
      expect(run.code).toBe(4);
      expect(run.stderr).toContain("'smoke' under the state directory is a link");
      expect(everything(batch)).not.toContain(CANARY);
      expect(everything(batch)).not.toContain("link-target");
      expect(existsSync(join(target, "status.json"))).toBe(true);
      expect(batch.calls.filter((c) => c.key === "up")).toHaveLength(0);
    });

    it("refuses a logs directory that is a link", () => {
      const ws = makeWorkspace();
      const target = makeLinkTarget(ws);
      linkDir(join(target, "logs"), join(smokeDir(ws), "logs"));
      const batch = runBatch(ws, SMOKE_CHECK, [
        ["-StateRoot", ws.state, "-EnvFile", ws.envFile, "-RepoRoot", ws.repo, ...POLL],
      ]);
      expect(batch.runs[0]!.code).toBe(4);
      expect(batch.runs[0]!.stderr).toContain("'smoke/logs' under the state directory is a link");
      expect(everything(batch)).not.toContain(CANARY);
    });

    it("refuses an entrypoint.log that is a file symlink (skipped with a reason where none can be made)", () => {
      const ws = makeWorkspace();
      const target = makeLinkTarget(ws);
      const reason = tryLinkFile(join(target, "logs", "entrypoint.log"), logPath(ws));
      if (reason !== undefined) {
        console.warn(`SKIPPED: ${reason}; files are covered through a junction parent`);
        return;
      }
      const batch = runBatch(ws, SMOKE_CHECK, [
        ["-StateRoot", ws.state, "-EnvFile", ws.envFile, "-RepoRoot", ws.repo, ...POLL],
      ]);
      expect(batch.runs[0]!.code).toBe(4);
      expect(batch.runs[0]!.stderr).toContain("'smoke/logs/entrypoint.log'");
      expect(everything(batch)).not.toContain(CANARY);
    });

    it("does not read the log or the status file through links planted while it waits", () => {
      const ws = makeWorkspace();
      const target = makeLinkTarget(ws);
      // The container starts, then swaps its state directory for a link to a directory holding a
      // green status file and a log: the poll and the log tail must both refuse it.
      const batch = runBatch(
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
            up: { linkDir: { path: smokeDir(ws), target } },
            "container:sprint-smoke": running(),
          },
        },
      );
      const run = batch.runs[0]!;
      expect(run.stdout).toContain("RESULT: FAIL");
      expect(run.stdout).toContain("final_state: link refused");
      expect(run.stdout).toContain("entrypoint.log not read: 'smoke' is a link, refused");
      expect(everything(batch)).not.toContain(CANARY);
      expect(everything(batch)).not.toContain("link-target");
    });
  },
);
