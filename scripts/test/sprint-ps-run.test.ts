import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BatchResult,
  CANARY,
  type DockerPlan,
  dockerForm,
  linkDir,
  makeLinkTarget,
  makeNodeOnlyDir,
  makeWorkspace,
  runArgs,
  runBatch,
  RUN_SPRINT,
  SAME_REPO_URL,
  SENTINEL,
  SHELL,
  SKIP_REASON,
  SPRINT_SCRIPTS,
  tryLinkFile,
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
// "a-b": a hyphen would let sprint "a" claim the sibling containers sd-a-b-* of sprint "a-b".
const BAD_IDS = ["..", "a/b", "", "-x", "a b", "ok\nx", "a-b"];
const DEFAULT_IMAGE = "sessiondeck-sprint:local";
const AMBIENT_IMAGE = "attacker/image:evil";
const IMAGE_LINE = "sha256:feedbeef created 2026-10-01T00:00:00Z";
const MISSING_IMAGE = "sessiondeck-sprint:other";
const DOWN_IMAGE = "sessiondeck-sprint:down";
const FOREIGN_IMAGE = "ghcr.io/attacker/x:1";
const REMOTE_HOST = "tcp://remote-daemon.example:2375";
const REMOTE_CONTEXT = "remote-box";
const REMOTE_CONFIG_DIR = "C:/remote-docker-config-dir";

// Every case after the bad ids, by index into the batch.
const FIRST = BAD_IDS.length;
const CASE = {
  missingEnv: FIRST + 0,
  unknownSprint: FIRST + 1,
  noSha: FIRST + 2,
  badSha: FIRST + 3,
  sprintZero: FIRST + 4,
  smokeStart: FIRST + 5,
  noResumeConflict: FIRST + 6,
  resumeNoDir: FIRST + 7,
  resumeLive: FIRST + 8,
  runningRefused: FIRST + 9,
  upFails: FIRST + 10,
  psFails: FIRST + 11,
  smokeDry: FIRST + 12,
  sprintThree: FIRST + 13,
  sprintZeroDry: FIRST + 14,
  smokeBuild: FIRST + 15,
  smokeOtherImage: FIRST + 16,
  badImage: FIRST + 17,
  urlCredentials: FIRST + 18,
  urlHttp: FIRST + 19,
  urlSsh: FIRST + 20,
  urlForeignHost: FIRST + 21,
  urlForeignRepo: FIRST + 22,
  urlForeignRepoAllowed: FIRST + 23,
  urlLeadingSpace: FIRST + 24,
  urlTrailingSpace: FIRST + 25,
  urlForeignHostAllowed: FIRST + 26,
  urlMixedCase: FIRST + 27,
  urlFromOrigin: FIRST + 28,
  foreignImage: FIRST + 29,
  foreignImageAllowed: FIRST + 30,
  foreignImageBadShape: FIRST + 31,
  badTag: FIRST + 32,
  imageDaemonDown: FIRST + 33,
} as const;

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
  const dry = (extra: string[], url?: string) => runArgs(ws, "smoke", ["-DryRun", ...extra], url);

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
        SAME_REPO_URL,
      ], // 6
      runArgs(ws, "7"),
      runArgs(ws, "1"),
      runArgs(ws, "1", ["-ContractSha", "bad sha!"]),
      runArgs(ws, "0"),
      runArgs(ws, "smoke"),
      runArgs(ws, "2", ["-ContractSha", SHA]),
      runArgs(ws, "4", ["-Resume", "-ContractSha", SHA]),
      runArgs(ws, "2", ["-Resume", "-ContractSha", SHA]),
      runArgs(ws, "4", ["-ContractSha", SHA]),
      runArgs(ws, "5", ["-ContractSha", SHA]),
      runArgs(ws, "1", ["-ContractSha", SHA]),
      dry([]),
      runArgs(ws, "3", ["-ContractSha", SHA]),
      runArgs(ws, "0", ["-DryRun"]),
      runArgs(ws, "smoke", ["-Build"]),
      dry(["-Image", MISSING_IMAGE]),
      dry(["-Image", "a b"]),
      dry([], "https://user:hunter2@github.com/owner/repo"),
      dry([], "http://github.com/owner/repo"),
      dry([], "git@github.com:owner/repo.git"),
      dry([], "https://gitlab.com/owner/repo"),
      dry([], "https://github.com/attacker/repo"),
      dry(["-AllowForeignRepo"], "https://github.com/attacker/repo"),
      dry([], " https://github.com/owner/repo"),
      dry([], "https://github.com/owner/repo "),
      dry(["-AllowForeignRepo"], "https://gitlab.com/owner/repo"),
      dry([], "https://github.com/OWNER/REPO.git"),
      // No -RepoUrl at all: the clone URL is the origin remote.
      [
        "-Sprint",
        "smoke",
        "-RepoRoot",
        ws.repo,
        "-StateRoot",
        ws.state,
        "-EnvFile",
        ws.envFile,
        "-DryRun",
      ],
      dry(["-Image", FOREIGN_IMAGE]),
      dry(["-Image", FOREIGN_IMAGE, "-AllowForeignImage"]),
      dry(["-Image", "a b", "-AllowForeignImage"]),
      dry(["-Image", "sessiondeck-sprint:a/b"]),
      dry(["-Image", DOWN_IMAGE]),
    ];
    batch = runBatch(ws, RUN_SPRINT, lists, {
      env: { SPRINT_IMAGE: AMBIENT_IMAGE },
      plan: {
        "ps:sprint-1": { code: 1 },
        "ps:sprint-2": { out: "sprint-2" },
        "ps:sprint-4": { out: "sprint-4" },
        "ps:sprint-5": { out: "sprint-50\nsprint-5x" },
        "up:sprint-5": { code: 7 },
        [`image-inspect:${DEFAULT_IMAGE}`]: { out: IMAGE_LINE },
        [`image-inspect:${MISSING_IMAGE}`]: {
          code: 1,
          err: "Error response from daemon: No such image",
        },
        [`image-inspect:${DOWN_IMAGE}`]: {
          code: 1,
          err: "error during connect: Cannot connect to the Docker daemon",
        },
      },
    });
  }, 120_000);

  it("rejects bad ids with exit 2 naming the rule, before any docker call", () => {
    BAD_IDS.forEach((_, i) => {
      expect(run(i).code, `case ${i}`).toBe(2);
      expect(run(i).stderr).toContain("letters, digits and underscore");
    });
    // Only the later cases reach "docker context show"; a bad id must not reach any other call.
    expect(
      batch.calls.filter(
        (c) => c.key !== "context" && (c.name === null || /-\./.test(c.name ?? "")),
      ),
    ).toEqual([]);
    expect(readdirSync(ws.state).sort()).toEqual(["0", "2", "3", "5", "smoke"]);
  });

  it("names a missing env file with exit 3", () => {
    const r = run(CASE.missingEnv);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("env file");
    expect(r.stderr).toContain("envfile.txt");
  });

  it("stops with the renderer's message on unknown sprint or missing sha", () => {
    expect(run(CASE.unknownSprint).code).toBe(2);
    expect(run(CASE.unknownSprint).stderr).toContain("unknown sprint");
    expect(run(CASE.noSha).code).toBe(2);
    expect(run(CASE.noSha).stderr).toContain("--contract-sha");
    expect(run(CASE.badSha).code).toBe(2);
    expect(existsSync(join(ws.state, "7"))).toBe(false);
  });

  it("refuses sprint 0 (runs_in local) with exit 2 naming runs_in, writing and starting nothing", () => {
    const r = run(CASE.sprintZero);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("runs_in='local'");
    expect(r.stderr).toContain("CONDUCTOR.md");
    expect(callsFor("sprint-0", "up")).toHaveLength(0);
  });

  it("-DryRun on a local package warns about runs_in, exits 0 and still starts nothing", () => {
    const r = run(CASE.sprintZeroDry);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("runs_in='local'");
    expect(r.stderr).toContain("would exit 2");
    expect(r.stdout).toContain("dry run: nothing was started");
    expect(callsFor("sprint-0", "up")).toHaveLength(0);
    expect(readFileSync(join(ws.state, "0", "sprint-prompt.md"), "utf8")).toContain(
      "sprint/0-bootstrap",
    );
  });

  it("starts a container package: layout, rendered prompt, and the recorded compose call", () => {
    const r = run(CASE.sprintThree);
    expect(r.code, r.stderr).toBe(0);
    const dir = join(ws.state, "3");
    expect(readdirSync(dir).sort()).toEqual([...STATE_SUBDIRS, "sprint-prompt.md"].sort());
    expect(existsSync(join(dir, "status.json"))).toBe(false);
    const prompt = readFileSync(join(dir, "sprint-prompt.md"), "utf8");
    expect(prompt).toContain("sprint/3-");
    expect(prompt.includes("\r")).toBe(false);

    const [up] = callsFor("sprint-3", "up");
    expect(up!.argv).toEqual([
      "compose",
      "-p",
      "sprint-3",
      "-f",
      dockerForm(join(ws.repo, "infra", "sprint", "docker-compose.yml")),
      "up",
      "-d",
    ]);
    expect(up!.env).toEqual({
      SPRINT_IMAGE: DEFAULT_IMAGE,
      SPRINT_ID: "3",
      SPRINT_BRANCH: packageBranch("3"),
      SPRINT_REPO_URL: SAME_REPO_URL,
      SPRINT_ENV_FILE: dockerForm(ws.envFile),
      SPRINT_STATE_ROOT: dockerForm(ws.state),
    });
    expect(up!.secretNames).toEqual([]);
    expect(callsFor("sprint-3", "ps")).toHaveLength(1);
  });

  it("sets SPRINT_IMAGE itself: an ambient value never reaches compose", () => {
    const ups = batch.calls.filter((c) => c.key === "up");
    expect(ups.length).toBeGreaterThan(0);
    for (const up of ups) {
      expect(up.env.SPRINT_IMAGE, up.name ?? "").not.toBe(AMBIENT_IMAGE);
    }
    expect(run(CASE.smokeOtherImage).stdout).toContain(`SPRINT_IMAGE=${MISSING_IMAGE}`);
    expect(run(CASE.smokeDry).stdout).toContain(`SPRINT_IMAGE=${DEFAULT_IMAGE}`);
    expect(run(CASE.badImage).code).toBe(2);
    expect(run(CASE.badImage).stderr).toContain("-Image");
  });

  it("accepts only sessiondeck-sprint:<tag> as -Image unless -AllowForeignImage is given", () => {
    const refused = run(CASE.foreignImage);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("-AllowForeignImage");
    expect(refused.stderr).not.toContain("attacker");
    expect(run(CASE.badImage).code).toBe(2);
    expect(run(CASE.badImage).stderr).toContain("-AllowForeignImage");
    expect(run(CASE.badTag).code).toBe(2); // a slash is not part of a tag
    const allowed = run(CASE.foreignImageAllowed);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain(`SPRINT_IMAGE=${FOREIGN_IMAGE}`);
    // The switch widens the image, not the syntax.
    expect(run(CASE.foreignImageBadShape).code).toBe(2);
    expect(run(CASE.foreignImageBadShape).stderr).toContain("docker image reference");
    expect(callsFor(FOREIGN_IMAGE, "image-inspect")).toHaveLength(1); // only the allowed run
  });

  it("treats only 'No such image' as a missing image; any other inspect failure is exit 5", () => {
    const down = run(CASE.imageDaemonDown);
    expect(down.code).toBe(5);
    expect(down.stderr).toContain("is Docker running?");
    expect(down.stdout).not.toContain("image missing");
  });

  it("renders the one-line smoke prompt and starts with an empty branch", () => {
    const r = run(CASE.smokeStart);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(ws.state, "smoke", "sprint-prompt.md"), "utf8")).toBe(SMOKE_PROMPT);
    const [up] = callsFor("sprint-smoke", "up");
    expect(up!.env.SPRINT_ID).toBe("smoke");
    expect(up!.env.SPRINT_BRANCH ?? "").toBe("");
  });

  it("refuses without -Resume when status.json exists, and without a state dir when resuming", () => {
    expect(run(CASE.noResumeConflict).code).toBe(4);
    expect(run(CASE.noResumeConflict).stderr).toContain("-Resume");
    expect(run(CASE.resumeNoDir).code).toBe(4);
    expect(existsSync(join(ws.state, "4"))).toBe(false);
    expect(callsFor("sprint-2", "up")).toHaveLength(1); // only the -Resume run reached docker
  });

  it("-Resume keeps the state dir and recreates the container even while it is running", () => {
    const r = run(CASE.resumeLive);
    expect(r.code, r.stderr).toBe(0);
    // The plan says sprint-2 is running; -Resume does not refuse over that, it recreates.
    expect(callsFor("sprint-2", "ps")).toHaveLength(0);
    const dir = join(ws.state, "2");
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("kept");
    expect(readFileSync(join(dir, "status.json"), "utf8")).toBe('{"state":"running"}');
    expect(readFileSync(join(dir, "sprint-prompt.md"), "utf8")).toContain("sprint/2-");
    expect(callsFor("sprint-2", "up")[0]!.argv.slice(-3)).toEqual(["up", "-d", "--force-recreate"]);
  });

  it("without -Resume a running container is refused with exit 4 and a pointer to stop-sprint", () => {
    const r = run(CASE.runningRefused);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("stop-sprint.ps1");
    expect(callsFor("sprint-4", "up")).toHaveLength(0);
    expect(existsSync(join(ws.state, "4"))).toBe(false);
  });

  it("maps docker failures to exit 5 and ignores look-alike container names", () => {
    // sprint-50 and sprint-5x are running, sprint-5 is not, so the start was attempted and failed.
    expect(run(CASE.upFails).code).toBe(5);
    expect(callsFor("sprint-5", "up")).toHaveLength(1);
    expect(run(CASE.psFails).code).toBe(5);
    expect(run(CASE.psFails).stderr).toContain("docker ps failed");
    expect(callsFor("sprint-1", "up")).toHaveLength(0);
  });

  it("-DryRun prints the command and variables and makes no state-changing docker call", () => {
    const r = run(CASE.smokeDry);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("would run: docker compose -p sprint-smoke -f ");
    expect(r.stdout).toContain("up -d");
    expect(r.stdout).toContain("SPRINT_ID=smoke");
    expect(r.stdout).toContain(`SPRINT_ENV_FILE=${dockerForm(ws.envFile)}`);
    expect(r.stdout).toContain(`SPRINT_STATE_ROOT=${dockerForm(ws.state)}`);
    expect(callsFor("sprint-smoke", "up")).toHaveLength(2); // the real starts only: cases 11 and 21
  });

  it("prints the image id and created time compose will use, or says it will build", () => {
    expect(run(CASE.smokeStart).stdout).toContain(`image ${DEFAULT_IMAGE}: ${IMAGE_LINE}`);
    const missing = run(CASE.smokeOtherImage);
    expect(missing.code, missing.stderr).toBe(0); // docker's stderr must not abort the script
    expect(missing.stdout).toContain(
      `image ${MISSING_IMAGE}: image missing: compose will build it, this can take about 10 minutes`,
    );
  });

  it("-Build passes --build to compose up and says so; nothing else ever does", () => {
    const r = run(CASE.smokeBuild);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("-Build given, compose rebuilds it first");
    const withBuild = batch.calls.filter((c) => c.argv.includes("--build"));
    expect(withBuild).toHaveLength(1);
    expect(withBuild[0]!.argv.slice(-3)).toEqual(["up", "-d", "--build"]);
    expect(batch.calls.flatMap((c) => c.argv)).not.toContain("build");
  });

  it("accepts only github.com https URLs without credentials, and never echoes a rejected URL", () => {
    for (const bad of [
      CASE.urlCredentials,
      CASE.urlHttp,
      CASE.urlSsh,
      CASE.urlForeignHost,
      CASE.urlLeadingSpace,
      CASE.urlTrailingSpace,
      CASE.urlForeignHostAllowed, // the switch widens the repository, never the host
    ]) {
      expect(run(bad).code, `case ${bad}`).toBe(2);
      expect(run(bad).stderr).toContain("https://github.com/OWNER/REPO");
      expect(run(bad).stderr).not.toContain("hunter2");
      expect(run(bad).stdout).not.toContain("hunter2");
    }
    expect(JSON.stringify(batch.calls)).not.toContain("hunter2");
  });

  it("requires the repository of the origin remote unless -AllowForeignRepo is given", () => {
    const refused = run(CASE.urlForeignRepo);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("different repository than origin");
    expect(refused.stderr).toContain("-AllowForeignRepo");
    expect(refused.stderr).not.toContain("attacker");

    const allowed = run(CASE.urlForeignRepoAllowed);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain("SPRINT_REPO_URL=https://github.com/attacker/repo");
  });

  it("compares owner and repo case-insensitively and takes origin itself when no URL is given", () => {
    const mixed = run(CASE.urlMixedCase);
    expect(mixed.code, mixed.stderr).toBe(0);
    expect(mixed.stdout).toContain("SPRINT_REPO_URL=https://github.com/OWNER/REPO.git");
    const fromOrigin = run(CASE.urlFromOrigin);
    expect(fromOrigin.code, fromOrigin.stderr).toBe(0);
    expect(fromOrigin.stdout).toContain("SPRINT_REPO_URL=https://github.com/Owner/Repo");
  });

  it("never reads the env file: the sentinel is in no output, argv or recorded variable", () => {
    const everything = JSON.stringify([batch.stdout, batch.stderr, batch.calls]);
    expect(everything).not.toContain(SENTINEL);
    for (const call of batch.calls) {
      expect(call.secretNames).toEqual([]);
      expect(call.argv.join(" ")).not.toMatch(/token|--env-file/i);
    }
  });

  it("only ever issues read-only queries plus the compose up per start", () => {
    const keys = new Set(batch.calls.map((c) => c.key));
    expect([...keys].sort()).toEqual(["context", "image-inspect", "ps", "up"]);
    for (const call of batch.calls.filter((c) => c.key === "image-inspect")) {
      expect(call.argv.slice(0, 2)).toEqual(["image", "inspect"]);
    }
  });
});

describe.skipIf(SHELL === undefined)("run-sprint.ps1 refuses a remote docker target", () => {
  const dryRun = (ws: Workspace) => runArgs(ws, "smoke", ["-DryRun"]);
  const refusal = (env: Record<string, string>, plan: DockerPlan = {}) => {
    const ws = makeWorkspace();
    const result = runBatch(ws, RUN_SPRINT, [dryRun(ws)], { env, plan });
    return { run: result.runs[0]!, calls: result.calls, everything: result.stdout + result.stderr };
  };

  it("exits 3 naming DOCKER_HOST, never its value, before any docker call", () => {
    const r = refusal({ DOCKER_HOST: REMOTE_HOST });
    expect(r.run.code, r.run.stderr).toBe(3);
    expect(r.run.stderr).toContain("DOCKER_HOST");
    expect(r.everything).not.toContain("remote-daemon");
    expect(r.calls).toEqual([]);
  });

  it("exits 3 naming DOCKER_CONTEXT unless it is default or desktop-linux", () => {
    const r = refusal({ DOCKER_CONTEXT: REMOTE_CONTEXT });
    expect(r.run.code, r.run.stderr).toBe(3);
    expect(r.run.stderr).toContain("DOCKER_CONTEXT");
    expect(r.everything).not.toContain(REMOTE_CONTEXT);
    expect(r.calls).toEqual([]);
    for (const local of ["default", "desktop-linux"]) {
      const ok = refusal({ DOCKER_CONTEXT: local });
      expect(ok.run.code, ok.run.stderr).toBe(0);
    }
  });

  it("exits 3 naming DOCKER_CONFIG, never its value, before any docker call", () => {
    const r = refusal({ DOCKER_CONFIG: REMOTE_CONFIG_DIR });
    expect(r.run.code, r.run.stderr).toBe(3);
    expect(r.run.stderr).toContain("DOCKER_CONFIG");
    expect(r.everything).not.toContain(REMOTE_CONFIG_DIR);
    expect(r.calls).toEqual([]);
  });

  it("exits 3 when docker context show names a remote context, without echoing its name", () => {
    const r = refusal({}, { context: { out: REMOTE_CONTEXT } });
    expect(r.run.code, r.run.stderr).toBe(3);
    expect(r.run.stderr).toContain("docker context");
    expect(r.everything).not.toContain(REMOTE_CONTEXT);
    expect(r.calls.map((c) => c.key)).toEqual(["context"]);
    expect(r.calls[0]!.argv).toEqual(["context", "show"]);
  });

  it("exits 3 when docker context show fails or prints nothing, and accepts a local context", () => {
    const failing = refusal({}, { context: { code: 1, err: "boom" } });
    expect(failing.run.code, failing.run.stderr).toBe(3);
    const silent = refusal({}, { context: { out: "" } });
    expect(silent.run.code, silent.run.stderr).toBe(3);
    const desktop = refusal({}, { context: { out: "desktop-linux" } });
    expect(desktop.run.code, desktop.run.stderr).toBe(0);
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

  it("fails with exit 3 when infra/sprint/.env exists, before any docker call", () => {
    const ws = makeWorkspace();
    const composeEnv = join(ws.repo, "infra", "sprint", ".env");
    writeFileSync(composeEnv, `SPRINT_IMAGE=${AMBIENT_IMAGE}\n`);
    const result = runBatch(ws, RUN_SPRINT, [
      runArgs(ws, "smoke"),
      runArgs(ws, "smoke", ["-DryRun"]),
    ]);
    for (const r of result.runs) {
      expect(r.code, r.stderr).toBe(3);
      expect(r.stderr).toContain(".env exists");
      expect(r.stderr).toContain("variable interpolation");
      expect(r.stderr + r.stdout).not.toContain(AMBIENT_IMAGE); // the file is never read
    }
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

describe.skipIf(SHELL === undefined)(
  "run-sprint.ps1 refuses links planted in the state directory",
  () => {
    const dry = (ws: Workspace, id: string) =>
      runArgs(ws, id, id === "smoke" ? ["-DryRun"] : ["-DryRun", "-ContractSha", SHA]);
    const noUp = (b: BatchResult) => b.calls.filter((c) => c.key === "up");

    it("refuses a sprint directory and a subdirectory that are links, and writes nothing through them", () => {
      const ws = makeWorkspace();
      const target = makeLinkTarget(ws);
      linkDir(target, join(ws.state, "3"));
      linkDir(join(target, "sessions"), join(ws.state, "smoke", "reports"));
      const before = readdirSync(target).sort();
      const batch = runBatch(ws, RUN_SPRINT, [dry(ws, "3"), dry(ws, "smoke")]);
      expect(batch.runs[0]!.code, batch.runs[0]!.stderr).toBe(4);
      expect(batch.runs[0]!.stderr).toContain("'3' under the state directory is a link");
      expect(batch.runs[1]!.code, batch.runs[1]!.stderr).toBe(4);
      expect(batch.runs[1]!.stderr).toContain(
        "'smoke/reports' under the state directory is a link",
      );
      expect(batch.stdout + batch.stderr).not.toContain("link-target");
      expect(batch.stdout + batch.stderr).not.toContain(CANARY);
      expect(readdirSync(target).sort()).toEqual(before);
      expect(readdirSync(join(target, "sessions")).sort()).toEqual(["s1.json"]);
      expect(noUp(batch)).toHaveLength(0);
    });

    it("refuses a planted link beside the prompt file, and a prompt file that is a symlink", () => {
      const ws = makeWorkspace();
      const target = makeLinkTarget(ws);
      // The renderer's temporary name is guessable: a link with that name must stop the run.
      linkDir(target, join(ws.state, "smoke", ".sprint-prompt.md.4.tmp"));
      const reason = tryLinkFile(
        join(target, "status.json"),
        join(ws.state, "3", "sprint-prompt.md"),
      );
      const lists = reason === undefined ? [dry(ws, "smoke"), dry(ws, "3")] : [dry(ws, "smoke")];
      const batch = runBatch(ws, RUN_SPRINT, lists);
      expect(batch.runs[0]!.code, batch.runs[0]!.stderr).toBe(4);
      expect(batch.runs[0]!.stderr).toContain("'smoke/.sprint-prompt.md.4.tmp'");
      if (reason === undefined) {
        expect(batch.runs[1]!.code, batch.runs[1]!.stderr).toBe(4);
        expect(batch.runs[1]!.stderr).toContain("'3/sprint-prompt.md'");
      } else {
        console.warn(`SKIPPED: ${reason}; files are covered through a junction parent`);
      }
      expect(readFileSync(join(target, "status.json"), "utf8")).toContain(CANARY);
      expect(batch.stdout + batch.stderr).not.toContain(CANARY);
      expect(noUp(batch)).toHaveLength(0);
    });
  },
);
