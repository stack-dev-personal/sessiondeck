import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256, resolveDeployDir } from "../lib/deploy.mjs";
import { DEPLOY_FILES, DEPLOY_MANIFEST } from "../lib/install-config.mjs";
import { HOOK_EVENTS } from "../lib/hook-events.mjs";
import {
  cleanupTempDirs,
  loadJson,
  makeTempDir,
  runScript,
  runInstallInProcess,
  REPO_ROOT,
  SCRIPTS_DIR,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const install = (e: InstallEnv, extra: string[] = []) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--apply", ...extra]);
const uninstall = (e: InstallEnv) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--uninstall", "--apply"]);
const readSidecar = (e: InstallEnv) =>
  loadJson(join(e.configDir, "settings.json.sessiondeck-capture-state.json"));
const posix = (p: string) => p.replace(/\\/g, "/");

/** Relative imports of a source file, e.g. "./lib/capture-core.mjs" -> "lib/capture-core.mjs". */
function importsOf(file: string): string[] {
  const text = readFileSync(join(SCRIPTS_DIR, file), "utf8");
  const specs = [...text.matchAll(/(?:from |import\()"(\.[^"]+)"/g)].map((m) => m[1]!);
  return specs.map((s) =>
    posix(resolve(dirname(join(SCRIPTS_DIR, file)), s)).replace(`${posix(SCRIPTS_DIR)}/`, ""),
  );
}

function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const dep of importsOf(entry)) closure(dep, seen);
  return seen;
}

describe("deployed copy", () => {
  it("registers paths in the deploy dir, never in the repo", async () => {
    const env = setupInstallEnv();
    expect((await install(env)).code).toBe(0);
    const settings = loadJson(env.target);
    const deployReal = posix(realpathSync.native(env.deployDir));
    const commands: string[] = [
      ...HOOK_EVENTS.map((e) => settings.hooks[e].at(-1).hooks[0].args[0] as string),
      settings.statusLine.command,
      settings.subagentStatusLine.command,
    ];
    for (const command of commands) {
      expect(command).toContain(`${deployReal}/`);
      expect(command.toLowerCase()).not.toContain(posix(REPO_ROOT).toLowerCase());
    }
  });

  it("records a manifest whose hashes match both the source and the deployed files", async () => {
    const env = setupInstallEnv();
    await install(env);
    const { deploy } = readSidecar(env);
    expect(deploy.files.map((f: { path: string }) => f.path)).toEqual([...DEPLOY_MANIFEST]);
    for (const file of deploy.files) {
      expect(sha256(readFileSync(join(env.deployDir, file.path)))).toBe(file.sha256);
      expect(sha256(readFileSync(join(SCRIPTS_DIR, file.path)))).toBe(file.sha256);
    }
  });

  it("DEPLOY_FILES is exactly the import closure of the hook, so nothing is imported from the repo", () => {
    const files = [...closure("capture-fixtures.mjs")].sort();
    expect(files).toEqual([...DEPLOY_FILES].sort());
    for (const file of files) {
      const text = readFileSync(join(SCRIPTS_DIR, file), "utf8");
      const specs = [...text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1]!);
      expect(specs.every((s) => s.startsWith("node:") || s.startsWith("."))).toBe(true);
    }
  });

  it("the deployed hook runs on its own", async () => {
    const env = setupInstallEnv();
    await install(env);
    const out = join(env.sandbox, "own-out");
    const r = await runScript(
      join(env.deployDir, "capture-fixtures.mjs"),
      ["--marker", "sessiondeck-capture", "--out", out],
      { sandbox: env.sandbox, input: '{"hook_event_name":"Stop","session_id":"abc"}' },
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
  });

  it("detects a tampered deployed file on the next install and replaces it", async () => {
    const env = setupInstallEnv();
    await install(env);
    const victim = join(env.deployDir, "lib", "capture-core.mjs");
    const good = readFileSync(victim);
    writeFileSync(victim, 'console.log("injected");\n');
    const preview = await runInstallInProcess(env.configDir, env.sandbox, []);
    expect(preview.stdout).toMatch(/1 file\(s\) to write/);
    expect(readFileSync(victim, "utf8")).toContain("injected");
    const r = await install(env);
    expect(r.code).toBe(0);
    expect(readFileSync(victim).equals(good)).toBe(true);
    const again = await install(env);
    expect(again.stdout).toMatch(/Already installed/);
  });

  it("restores a deleted deployed file", async () => {
    const env = setupInstallEnv();
    await install(env);
    const victim = join(env.deployDir, "lib", "capture-store.mjs");
    const good = readFileSync(victim);
    rmSync(victim);
    expect(existsSync(victim)).toBe(false);
    const preview = await runInstallInProcess(env.configDir, env.sandbox, []);
    expect(preview.stdout).toContain("1 file(s) to write");
    expect((await install(env)).code).toBe(0);
    expect(readFileSync(victim).equals(good)).toBe(true);
  });

  it("uninstall removes only the manifest files; an extra file keeps the directory", async () => {
    const env = setupInstallEnv();
    await install(env);
    writeFileSync(join(env.deployDir, "notes.txt"), "mine");
    const r = await uninstall(env);
    expect(r.code).toBe(0);
    expect(readdirSync(env.deployDir)).toEqual(["notes.txt"]);
    expect(r.stdout).toMatch(/Directory kept/);
  });

  it("uninstall removes the directory when it is empty afterwards", async () => {
    const env = setupInstallEnv();
    await install(env);
    await uninstall(env);
    expect(existsSync(env.deployDir)).toBe(false);
  });

  it("refuses a deploy directory inside a git work tree and writes nothing", async () => {
    const env = setupInstallEnv();
    const work = join(env.sandbox, "worktree");
    mkdirSync(join(work, ".git"), { recursive: true });
    const before = readFileSync(env.target);
    const r = await runInstallInProcess(env.configDir, env.sandbox, ["--apply"], {
      SESSIONDECK_CAPTURE_HOME: join(work, "deploy"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/inside a git work tree/);
    expect(readFileSync(env.target).equals(before)).toBe(true);
    expect(existsSync(join(work, "deploy"))).toBe(false);
  });
});

describe("deploy location", () => {
  const home = makeTempDir();
  it("uses LOCALAPPDATA on Windows and XDG_DATA_HOME or ~/.local/share elsewhere", () => {
    const win = resolveDeployDir({ LOCALAPPDATA: join(home, "L") }, home, "win32");
    expect(posix(win)).toBe(posix(join(home, "L", "sessiondeck", "capture")));
    const xdg = resolveDeployDir({ XDG_DATA_HOME: join(home, "X") }, home, "linux");
    expect(posix(xdg)).toBe(posix(join(home, "X", "sessiondeck", "capture")));
    const fallback = resolveDeployDir({}, home, "linux");
    expect(posix(fallback)).toBe(posix(join(home, ".local", "share", "sessiondeck", "capture")));
  });

  it("SESSIONDECK_CAPTURE_HOME wins", () => {
    const dir = resolveDeployDir({ SESSIONDECK_CAPTURE_HOME: join(home, "here") }, home, "win32");
    expect(posix(dir)).toBe(posix(join(home, "here")));
  });
});
