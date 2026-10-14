import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT_BUSY,
  EXIT_FAILURE,
  EXIT_OK,
  REPLACE_FLAG,
  USAGE,
  runCli,
} from "../src/state-file-cli";

const CLI_PATH = fileURLToPath(new URL("../src/state-file-cli.ts", import.meta.url));
const NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "sd-climerge-"));
  await runCli(["init", stateDir]);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const sessionFile = (id: string): string => join(stateDir, "sessions", `${id}.json`);

describe("smoke package and merging over odd files", () => {
  it("write-sprint builds a complete smoke status.json (state green) on an empty directory", async () => {
    const dir = join(stateDir, "smoke");
    const run = await runCli([
      "write-sprint",
      dir,
      "sprint=smoke",
      "name=smoke",
      "branch=sprint/smoke",
      "state=green",
    ]);
    expect(run.code).toBe(EXIT_OK);
    const file = join(dir, "status.json");
    expect(await readJson(file)).toMatchObject({ sprint: "smoke", state: "green" });
    expect((await runCli(["read", file])).code).toBe(EXIT_OK);
  });

  it("write-session merges over a schema-invalid file and over one without updated_at", async () => {
    await writeFile(sessionFile("S6"), '{"state":"done","updated_at":"x"}');
    expect((await runCli(["write-session", stateDir, "S6", "state=green"])).code).toBe(EXIT_OK);
    await writeFile(sessionFile("S6"), '{"state":"running"}');
    expect((await runCli(["write-session", stateDir, "S6", "units_done=1"])).code).toBe(EXIT_OK);
  });

  it.each([
    ["0 bytes", ""],
    ["truncated JSON", '{"state":"runn'],
  ])("names the replace flag for %s, and the flag then overwrites", async (_name, text) => {
    await writeFile(sessionFile("S6"), text);
    const refused = await runCli(["write-session", stateDir, "S6", "state=green"]);
    expect(refused.code).toBe(EXIT_FAILURE);
    expect(refused.output).toContain(REPLACE_FLAG);
    const forced = await runCli(["write-session", stateDir, "S6", REPLACE_FLAG, "state=green"]);
    expect(forced.code).toBe(EXIT_OK);
    expect(await readJson(sessionFile("S6"))).toMatchObject({ state: "green" });
  });

  it("write-sprint keeps the other sessions when one id is written", async () => {
    const base = ["sprint=0", "name=n", "branch=b", "state=running"];
    const sessions = 'sessions={"S0":{"state":"green"},"S0b":{"state":"not-started"}}';
    await runCli(["write-sprint", stateDir, ...base, sessions]);
    const next = await runCli(["write-sprint", stateDir, 'sessions={"S0c":{"state":"running"}}']);
    const ids = Object.keys((JSON.parse(next.output) as { sessions: object }).sessions);
    expect(ids.sort()).toEqual(["S0", "S0b", "S0c"]);
  });

  it("reports a lock that stays held, without sleeping for real", async () => {
    await writeFile(join(stateDir, "status.json.lock"), "");
    let at = Date.now();
    const lock = {
      now: () => at,
      sleep: (ms: number): Promise<void> => {
        at += ms;
        return Promise.resolve();
      },
    };
    const run = await runCli(["write-sprint", stateDir, "state=running"], { lock });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.output).toMatch(/held by another writer/);
  });
});

describe("write-sprint over an unparsable status.json", () => {
  const sprintArgs = ["sprint=0", "name=n", "branch=b", "state=running"];
  const statusFile = (): string => join(stateDir, "status.json");

  it.each([
    ["0 bytes", ""],
    ["truncated JSON", '{"sprint":"0","sta'],
    ["a JSON array", "[]"],
  ])("names the replace flag for %s, and the flag then overwrites", async (_name, text) => {
    await writeFile(statusFile(), text);
    const refused = await runCli(["write-sprint", stateDir, ...sprintArgs]);
    expect(refused.code).toBe(EXIT_FAILURE);
    expect(refused.output).toContain(`pass ${REPLACE_FLAG} to overwrite it`);
    const forced = await runCli(["write-sprint", stateDir, REPLACE_FLAG, ...sprintArgs]);
    expect(forced.code).toBe(EXIT_OK);
    expect(await readJson(statusFile())).toMatchObject({ sprint: "0", state: "running" });
  });

  it("with the flag, drops the old content instead of merging it", async () => {
    await runCli(["write-sprint", stateDir, ...sprintArgs, 'sessions={"S0":{"state":"green"}}']);
    const forced = await runCli(["write-sprint", stateDir, ...sprintArgs, REPLACE_FLAG]);
    expect(forced.code).toBe(EXIT_OK);
    expect(await readJson(statusFile())).not.toHaveProperty("sessions");
  });

  it("documents the flag on write-sprint in the usage text", () => {
    expect(USAGE).toContain(`write-sprint <stateDir> [${REPLACE_FLAG}]`);
  });
});

describe("a file that stays busy", () => {
  const blocked = (code: string) => ({
    rename: (): Promise<void> => Promise.reject(Object.assign(new Error("x"), { code })),
    sleep: (): Promise<void> => Promise.resolve(),
  });

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "exits with the retry code on %s and says to run it again",
    async (code) => {
      for (const argv of [
        ["write-session", stateDir, "S1", "state=running"],
        ["write-sprint", stateDir, "sprint=0", "name=n", "branch=b", "state=running"],
      ]) {
        const run = await runCli(argv, blocked(code));
        expect(run.code).toBe(EXIT_BUSY);
        expect(run.output).toMatch(/busy, run the same command again/);
      }
    },
  );

  it("uses 75, distinct from the ordinary failure code, and documents it", () => {
    expect(EXIT_BUSY).toBe(75);
    expect(EXIT_BUSY).not.toBe(EXIT_FAILURE);
    expect(USAGE).toContain("75 file busy");
  });

  it("keeps a permanent write failure at the ordinary failure code", async () => {
    const run = await runCli(["write-session", stateDir, "S1", "state=running"], blocked("ENOSPC"));
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.output).not.toMatch(/busy/);
  });
});

describe("text fields and usage", () => {
  it("keeps numeric-looking text in text fields and still parses numbers elsewhere", async () => {
    const out = await runCli([
      "write-session",
      stateDir,
      "S1",
      "state=running",
      "current_unit=3",
      "branch=123",
      "last_report=true",
      "pr=4",
    ]);
    expect(out.code).toBe(EXIT_OK);
    expect(JSON.parse(out.output)).toMatchObject({
      current_unit: "3",
      branch: "123",
      last_report: "true",
      pr: 4,
    });
    const args = ["write-sprint", stateDir, "sprint=0", "name=1", "branch=2", "state=running"];
    expect(JSON.parse((await runCli(args)).output)).toMatchObject({ name: "1", branch: "2" });
  });

  it("prints a usage text that documents the flag and the text fields", async () => {
    const run = await runCli([]);
    expect(run.output).toBe(`state-file: ${USAGE}\n`);
    expect(USAGE).toContain(REPLACE_FLAG);
    expect(USAGE).toContain("current_unit");
  });
});

describe("no credential is echoed on any error path", () => {
  const body = "A1b2C3d4".repeat(4);
  const token = "gh" + "p_" + body;
  // The directory is a placeholder so each case reads like the command line a session would run.
  const D = "<dir>";

  it.each([
    [
      "an unquoted bearer value split in two",
      ["write-session", D, "S1", "last_report=Bearer", token],
    ],
    ["a token as a lone argument", ["write-session", D, "S1", token]],
    ["a token as the session id", ["write-session", D, `${token}/x`, "state=running"]],
    ["a token as the state value", ["write-session", D, "S1", `state=${token}`]],
    [
      "a token inside a text value",
      ["write-session", D, "S1", "state=running", `last_report=${token}`],
    ],
    ["a token as a key", ["write-session", D, "S1", `${token}=1`]],
    ["a token as the command", [token, "x"]],
    ["a token as the read path", ["read", token]],
    ["a token in a sprint value", ["write-sprint", D, `state=${token}`]],
  ])("%s", async (_name, args) => {
    const argv = args.map((arg) => (arg === D ? stateDir : arg));
    const run = await runCli(argv);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.output).not.toContain(body);
  });

  it("holds for the spawned process as well", () => {
    const argv = [...NODE_FLAGS, CLI_PATH, "write-session", stateDir, "S1", `state=${token}`];
    const run = spawnSync(process.execPath, argv, { encoding: "utf8" });
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).not.toContain(body);
    expect(run.stdout).toBe("");
  });
});

describe("two processes merging into the same files", () => {
  const CLI_URL = pathToFileURL(CLI_PATH).href;
  const WRITES_PER_PROCESS = 8;

  /** One child node process doing interleaved merges; resolves with its exit code. */
  function child(id: string): Promise<number> {
    const script = `
      import { runCli } from ${JSON.stringify(CLI_URL)};
      const dir = ${JSON.stringify(stateDir)};
      let failed = 0;
      for (let i = 0; i < ${WRITES_PER_PROCESS}; i += 1) {
        const a = await runCli(["write-session", dir, "S1", "${id}_" + i + "=" + i]);
        const entry = JSON.stringify({ state: "running", units_done: i });
        const b = await runCli(["write-sprint", dir, "sessions={\\"${id}\\":" + entry + "}"]);
        failed += a.code + b.code;
      }
      process.exitCode = failed === 0 ? 0 : 1;
    `;
    return new Promise((resolve, reject) => {
      const args = [...NODE_FLAGS, "--input-type=module", "-e", script];
      const proc = spawn(process.execPath, args, { stdio: "ignore" });
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? 1));
    });
  }

  it("loses no key and no session entry", async () => {
    const base = ["sprint=0", "name=n", "branch=b", "state=running"];
    await runCli(["write-sprint", stateDir, ...base]);
    await runCli(["write-session", stateDir, "S1", "state=running"]);
    const codes = await Promise.all([child("pa"), child("pb")]);
    expect(codes).toEqual([0, 0]);
    const session = await readJson(sessionFile("S1"));
    const last = WRITES_PER_PROCESS - 1;
    for (const id of ["pa", "pb"]) {
      for (let i = 0; i <= last; i += 1) expect(session[`${id}_${i}`]).toBe(i);
    }
    const sessions = (await readJson(join(stateDir, "status.json")))["sessions"];
    expect(sessions).toMatchObject({ pa: { units_done: last }, pb: { units_done: last } });
  }, 30_000);
});
