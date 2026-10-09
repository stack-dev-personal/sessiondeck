import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeDeployed } from "../lib/deploy-remove.mjs";
import { sha256 } from "../lib/deploy.mjs";
import { parseSidecar, SidecarError } from "../lib/sidecar.mjs";
import {
  containsMarker,
  findRemaining,
  hasMarkerPair,
  hasMarkerTokens,
  isOurHook,
  isOurStatus,
} from "../lib/settings-match.mjs";
import {
  cleanupTempDirs,
  loadJson,
  makeTempDir,
  runInstallInProcess,
  setupInstallEnv,
  type InstallEnv,
} from "./helpers";

afterAll(cleanupTempDirs);

const install = (e: InstallEnv) => runInstallInProcess(e.configDir, e.sandbox, ["--apply"]);
const uninstall = (e: InstallEnv, extra: string[] = []) =>
  runInstallInProcess(e.configDir, e.sandbox, ["--uninstall", "--apply", ...extra]);
const SIDECAR = "settings.json.sessiondeck-capture-state.json";
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2));

/** Hooks whose paths merely contain the marker text (the reviewer's reproduction). */
const lookalike = (home: string) => ({
  exec: {
    type: "command",
    command: "bash",
    args: [`${home}/tools/sessiondeck-capture-notes/guard.sh`],
  },
  shell: { type: "command", command: `bash ${home}/sessiondeck-capture/guard.sh --marker` },
});

describe("marker matching is exact (security review iteration 2)", () => {
  it("hasMarkerPair needs the adjacent flag and value", () => {
    expect(hasMarkerPair(["x", "--marker", "sessiondeck-capture"])).toBe(true);
    expect(hasMarkerPair(["--marker", "x", "sessiondeck-capture"])).toBe(false);
    expect(hasMarkerPair(["/a/sessiondeck-capture-notes/guard.sh"])).toBe(false);
    expect(hasMarkerPair("--marker sessiondeck-capture")).toBe(false);
  });

  it("hasMarkerTokens needs whole tokens", () => {
    expect(hasMarkerTokens('node "x" --marker sessiondeck-capture --statusline')).toBe(true);
    expect(hasMarkerTokens("bash /t/sessiondeck-capture-notes/guard.sh")).toBe(false);
    expect(hasMarkerTokens("node x --marker sessiondeck-capture-extra")).toBe(false);
    expect(hasMarkerTokens(undefined)).toBe(false);
  });

  it("containsMarker finds the pair wherever it sits, and not a mere path", () => {
    expect(containsMarker({ a: [{ args: ["--marker", "sessiondeck-capture"] }] })).toBe(true);
    expect(containsMarker({ a: ["node --marker sessiondeck-capture"] })).toBe(true);
    expect(containsMarker({ a: ["/t/sessiondeck-capture-notes/guard.sh"] })).toBe(false);
  });

  it("isOurHook, isOurStatus and findRemaining ignore look-alike paths", () => {
    const { exec, shell } = lookalike("/home/u");
    expect(isOurHook(exec, undefined)).toBe(false);
    expect(isOurHook(shell, undefined)).toBe(false);
    const status = { type: "command", command: "bash /t/sessiondeck-capture-notes/s.sh" };
    expect(isOurStatus(status, "statusLine", undefined)).toBe(false);
    expect(
      findRemaining({ hooks: { Stop: [{ hooks: [exec, shell] }] }, statusLine: status }),
    ).toEqual([]);
  });

  it("a look-alike hook survives install, re-install and uninstall, alone and in a shared group", async () => {
    const env = setupInstallEnv(false);
    const { exec, shell } = lookalike(env.sandbox);
    const original = {
      hooks: {
        Stop: [{ hooks: [exec] }],
        PreToolUse: [{ matcher: "Bash", hooks: [exec, shell] }],
      },
    };
    writeJson(env.target, original);
    expect((await install(env)).code).toBe(0);
    expect((await install(env)).code).toBe(0);
    const installed = loadJson(env.target);
    expect(installed.hooks.Stop[0]).toEqual({ hooks: [exec] });
    expect(installed.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [exec, shell] });
    expect(installed.hooks.Stop).toHaveLength(2);
    const r = await uninstall(env);
    expect(r.code).toBe(0);
    expect(loadJson(env.target)).toEqual(original);
    expect(r.stdout).not.toContain("sessiondeck-capture-notes");
  });

  it("a look-alike hook inside our own group stays, and the removal of ours is printed", async () => {
    const env = setupInstallEnv(false);
    const { exec } = lookalike(env.sandbox);
    writeJson(env.target, { hooks: {} });
    await install(env);
    const settings = loadJson(env.target);
    settings.hooks.Stop.at(-1).hooks.push(exec);
    writeJson(env.target, settings);
    await install(env);
    expect(
      loadJson(env.target).hooks.Stop.flatMap((g: { hooks: unknown[] }) => g.hooks),
    ).toContainEqual(exec);
    const preview = await runInstallInProcess(env.configDir, env.sandbox, ["--uninstall"]);
    expect(preview.stdout).toMatch(/^- hooks\.Stop: .*--marker/m);
    const r = await uninstall(env);
    expect(r.stdout).toMatch(/^- hooks\.Stop: .*--marker/m);
    const after = loadJson(env.target);
    expect(after.hooks.Stop).toEqual([{ hooks: [exec] }]);
  });
});

describe("a tampered state file cannot steer uninstall", () => {
  const state = (env: InstallEnv) => loadJson(join(env.configDir, SIDECAR));

  it("rejects recorded entries that do not carry the marker", async () => {
    const env = setupInstallEnv(false);
    await install(env);
    const good = state(env);
    const guard = { command: "node", args: ["/home/u/.claude/hooks/guard.mjs"] };
    for (const entries of [
      { ...good.entries, hook: guard },
      { ...good.entries, statusLine: "node /evil.mjs" },
      { ...good.entries, subagentStatusLine: "node /evil.mjs" },
    ]) {
      expect(() => parseSidecar({ ...good, entries })).toThrow(SidecarError);
    }
    expect(() => parseSidecar(good)).not.toThrow();
  });

  it("deletes nothing from a directory other than the resolved deploy dir", async () => {
    const env = setupInstallEnv(true);
    await install(env);
    const other = join(makeTempDir(), "unrelated");
    mkdirSync(join(other, "lib"), { recursive: true });
    cpSync(join(env.deployDir, "capture-fixtures.mjs"), join(other, "capture-fixtures.mjs"));
    cpSync(join(env.deployDir, "lib", "capture-core.mjs"), join(other, "lib", "capture-core.mjs"));
    writeJson(join(env.configDir, SIDECAR), {
      ...state(env),
      deploy: { ...state(env).deploy, dir: other },
    });
    const r = await uninstall(env);
    expect(r.code).toBe(1);
    expect(existsSync(join(other, "capture-fixtures.mjs"))).toBe(true);
    expect(existsSync(join(other, "lib", "capture-core.mjs"))).toBe(true);
    expect(r.stdout).toContain(other);
    expect(r.stdout).toContain("NOT removed");
    expect(JSON.stringify(loadJson(env.target))).not.toContain("sessiondeck-capture");
  });

  it("keeps a deployed file whose bytes no longer match the record", async () => {
    const env = setupInstallEnv(false);
    await install(env);
    const edited = join(env.deployDir, "lib", "capture-store.mjs");
    writeFileSync(edited, "// edited by someone else\n");
    const r = await uninstall(env);
    expect(r.code).toBe(0);
    expect(readFileSync(edited, "utf8")).toBe("// edited by someone else\n");
    expect(r.stdout).toContain(edited);
    expect(existsSync(join(env.deployDir, "capture-fixtures.mjs"))).toBe(false);
  });

  it("removeDeployed refuses a directory inside a git work tree", async () => {
    const tree = join(makeTempDir(), "work");
    mkdirSync(join(tree, ".git"), { recursive: true });
    const file = join(tree, "capture-fixtures.mjs");
    writeFileSync(file, "x");
    const result = await removeDeployed({
      dir: tree,
      files: [{ path: "capture-fixtures.mjs", sha256: sha256("x") }],
    });
    expect(result.refused).toBe(tree);
    expect(existsSync(file)).toBe(true);
  });
});
