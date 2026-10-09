import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_OK, runCli } from "../src/state-file-cli";

// fileURLToPath yields C:\... on Windows, never an /c/ path, which native node cannot read.
const CLI_PATH = fileURLToPath(new URL("../src/state-file-cli.ts", import.meta.url));
const NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "sd-cli-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function spawnCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [...NODE_FLAGS, CLI_PATH, ...args], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("state-file CLI as a process", () => {
  it("init creates the layout", async () => {
    const dir = join(stateDir, "0");
    const run = spawnCli("init", dir);
    expect(run.status).toBe(EXIT_OK);
    expect((await stat(join(dir, "gate"))).isDirectory()).toBe(true);
    expect(JSON.parse(run.stdout)).toMatchObject({ stateDir: dir });
  });

  it("write-session merges into the existing file and read prints it", async () => {
    const first = spawnCli(
      "write-session",
      stateDir,
      "S1",
      "state=running",
      "units_total=5",
      "pr=null",
    );
    expect(first.status).toBe(EXIT_OK);
    const second = spawnCli(
      "write-session",
      stateDir,
      "S1",
      "units_done=2",
      "branch=p1/probe-hook",
    );
    expect(second.status).toBe(EXIT_OK);
    const file = join(stateDir, "sessions", "S1.json");
    const read = spawnCli("read", file);
    expect(read.status).toBe(EXIT_OK);
    expect(JSON.parse(read.stdout)).toMatchObject({
      state: "running",
      units_total: 5,
      units_done: 2,
      pr: null,
      branch: "p1/probe-hook",
    });
    expect(JSON.parse(await readFile(file, "utf8")).updated_at).toMatch(/Z$/);
  });

  it("exits non-zero with a one-line message on an invalid state", () => {
    const run = spawnCli("write-session", stateDir, "S1", "state=paused");
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toMatch(/^state-file: .*state/);
    expect(run.stdout).toBe("");
  });

  it("exits non-zero when the file is missing", () => {
    const run = spawnCli("read", join(stateDir, "status.json"));
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toMatch(/cannot read/);
  });
});

describe("runCli", () => {
  it("write-sprint creates then merges status.json", async () => {
    const base = ["sprint=0", "name=bootstrap", "branch=sprint/0-bootstrap", "state=running"];
    expect((await runCli(["write-sprint", stateDir, ...base])).code).toBe(EXIT_OK);
    const next = await runCli(["write-sprint", stateDir, "state=gate", 'gate={"state":"pending"}']);
    expect(next.code).toBe(EXIT_OK);
    expect(JSON.parse(next.output)).toMatchObject({
      name: "bootstrap",
      state: "gate",
      sprint: "0",
    });
  });

  it("keeps '=' inside values and rejects pairs without a key", async () => {
    const ok = await runCli(["write-session", stateDir, "S2", "state=blocked", "current_unit=a=b"]);
    expect(JSON.parse(ok.output)).toMatchObject({ current_unit: "a=b" });
    const bad = await runCli(["write-session", stateDir, "S2", "oops"]);
    expect(bad).toEqual({ code: EXIT_FAILURE, output: "state-file: not key=value: oops\n" });
  });

  it("surfaces an existing file that is broken instead of overwriting it", async () => {
    await writeFile(join(stateDir, "status.json"), "{ nope");
    const run = await runCli(["write-sprint", stateDir, "state=running"]);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.output).toMatch(/not valid JSON/);
  });

  it.each([
    [[]],
    [["init"]],
    [["init", "a", "b"]],
    [["read"]],
    [["write-session", "a"]],
    [["write-sprint"]],
    [["bogus", "a"]],
  ])("prints usage for %j", async (argv) => {
    const run = await runCli(argv);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.output).toMatch(/^state-file: usage:/);
  });

  it("rejects a hostile session id", async () => {
    const run = await runCli(["write-session", stateDir, "../x", "state=running"]);
    expect(run.output).toMatch(/invalid session id/);
  });
});
