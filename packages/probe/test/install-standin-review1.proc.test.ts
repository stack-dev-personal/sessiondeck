// Review fix round 1, part A: exe install sharing, quoting, home safety, forged state, stale build.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realResolve, realSlash } from "../src/install/real-path.ts";
import { ExeError, planExe } from "../src/install/exe.ts";
import { probeRoot } from "./helpers.ts";
import { type Doc, harnessFixture, readJson, runCli, sandbox } from "./fixtures/sandbox.ts";

const WIN = process.platform === "win32";
const EXT = WIN ? ".exe" : "";
const PLATFORM_DIR = WIN ? "windows-x64" : "linux-x64";
const NAMES = ["hook", "statusline", "subagents"];
const BUNDLES = ["hook.mjs", "statusline.mjs", "subagents.mjs"];
const MARKER = "--sessiondeck-probe";
const isOurs = (h: Doc): boolean => Array.isArray(h?.args) && h.args.includes(MARKER);
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function standIns(root: string, tag = "a"): string {
  const dir = join(root, `exe-src-${tag}`);
  mkdirSync(dir, { recursive: true });
  for (const n of NAMES) writeFileSync(join(dir, `${n}${EXT}`), `stand-in ${n} ${tag}\n`);
  return dir;
}

const exeInstall = (src: string, extra: string[] = []): string[] => [
  "install",
  "--runtime",
  "exe",
  "--exe-dir",
  src,
  ...extra,
];
const binDirs = (home: string): string[] =>
  existsSync(join(home, "bin")) ? readdirSync(join(home, "bin")) : [];
const ourHook = (settings: string): Doc =>
  readJson(settings)
    .hooks.Stop.flatMap((g: Doc) => g.hooks)
    .find(isOurs);

describe("review 1, finding 1: a shared exe directory is not pruned while another install uses it", () => {
  it("uninstalling one settings file keeps the folder the other still points at", async () => {
    const sb = sandbox(harnessFixture);
    const other = join(sb.root, "other-settings.json");
    writeFileSync(other, "{}\n");
    const src = standIns(sb.root);
    expect((await runCli(exeInstall(src), sb.env)).code).toBe(0);
    expect((await runCli(exeInstall(src, ["--settings", other]), sb.env)).code).toBe(0);
    expect(binDirs(sb.home)).toHaveLength(1);
    const r = await runCli(["uninstall", "--settings", other], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(binDirs(sb.home)).toHaveLength(1);
    expect(existsSync(ourHook(sb.settings).command)).toBe(true);
    // The last user removes it.
    expect((await runCli(["uninstall"], sb.env)).code).toBe(0);
    expect(binDirs(sb.home)).toHaveLength(0);
  });

  it("reinstalling only one profile with a new build keeps the old folder for the other", async () => {
    const sb = sandbox(harnessFixture);
    const other = join(sb.root, "other-settings.json");
    writeFileSync(other, "{}\n");
    await runCli(exeInstall(standIns(sb.root, "a")), sb.env);
    await runCli(exeInstall(standIns(sb.root, "a"), ["--settings", other]), sb.env);
    const r = await runCli(exeInstall(standIns(sb.root, "b")), sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(binDirs(sb.home)).toHaveLength(2);
    expect(existsSync(ourHook(other).command)).toBe(true);
    expect(existsSync(ourHook(sb.settings).command)).toBe(true);
  });
});

describe("review 1, finding 2: an exe path with a space keeps the status commands (Node form)", () => {
  it("hooks stay exe form, status commands use node + dist script, recorded, idempotent", async () => {
    const sb = sandbox(harnessFixture);
    const spaced = WIN
      ? join(sb.root, "home", "AppData", "Local", "sessiondeck", "Jane Doe")
      : join(sb.root, "probe home");
    const src = standIns(sb.root);
    const args = exeInstall(src, ["--home", spaced, "--statusline=replace"]);
    const r = await runCli(args, sb.env);
    expect(r.code, r.stderr).toBe(0);
    const hook = ourHook(sb.settings);
    expect(hook.command).toContain(" ");
    expect(hook.command).toMatch(/\/bin\/[0-9a-f]{12}\/hook(\.exe)?$/);
    const settings = readJson(sb.settings);
    const dist = join(probeRoot, "dist").replaceAll("\\", "/");
    const home = realResolve(spaced).replaceAll("\\", "/");
    const flags = `--home "${home}" --host`;
    for (const [key, script] of [
      ["statusLine", "statusline.mjs"],
      ["subagentStatusLine", "subagents.mjs"],
    ] as const) {
      expect(settings[key].command.startsWith(`node ${dist.includes(" ") ? '"' : ""}`)).toBe(true);
      expect(settings[key].command).toContain(`/dist/${script}`);
      expect(settings[key].command).toContain(flags);
      expect(settings[key].command.endsWith(` ${MARKER}`)).toBe(true);
    }
    expect(r.stdout).toMatch(/notice: .*status.*Node form/i);
    const state = Object.values<Doc>(readJson(join(spaced, "install-state.json")).installs)[0];
    expect(state.runtime).toBe("exe");
    expect(state.statusRuntime).toBe("node");
    const once = readFileSync(sb.settings, "utf8");
    await runCli(args, sb.env);
    expect(readFileSync(sb.settings, "utf8")).toBe(once);
  });

  it("buildCtx: a spaced exe path no longer skips; an unsafe home still does, with an accurate message", async () => {
    const { buildCtx } = await import("../src/install/run.ts");
    const plan = (dir: string): Parameters<typeof buildCtx>[3] => ({
      dir,
      files: [],
      paths: { hook: `${dir}/hook`, statusline: `${dir}/s`, subagents: `${dir}/u` },
    });
    const ok = buildCtx("/tmp/d", "/tmp/h", "h", plan("/tmp/h x/bin/abc"));
    expect(ok.statuslineCommand).toBe(
      `node ${realSlash("/tmp/d")}/statusline.mjs --home ${realSlash("/tmp/h")} --host h --sessiondeck-probe`,
    );
    expect(ok.hookExe).toBe("/tmp/h x/bin/abc/hook");
    expect(ok.statusRuntime).toBe("node");
    const bad = buildCtx("/tmp/d", "/tmp/h$x", "h", plan("/tmp/h x/bin/abc"));
    expect(bad.statuslineCommand).toBeUndefined();
    expect(bad.statusSkipReason).toContain("h$x");
  });
});

describe("review 1, finding 3: the exe form is refused in an unsafe probe home", () => {
  it("refuses a non-default shared home for --runtime exe, writes nothing, node form still works", async () => {
    const sb = sandbox(harnessFixture);
    // Windows: outside the profile. POSIX: group/world writable.
    const unsafe = join(sb.root, "shared-home");
    if (!WIN) {
      mkdirSync(unsafe, { recursive: true });
      chmodSync(unsafe, 0o777);
    }
    const before = readFileSync(sb.settings, "utf8");
    const r = await runCli(exeInstall(standIns(sb.root), ["--home", unsafe]), sb.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--runtime node|probe home/);
    expect(readFileSync(sb.settings, "utf8")).toBe(before);
    expect(existsSync(join(unsafe, "bin"))).toBe(false);
    const n = await runCli(["install", "--runtime", "node", "--home", unsafe], sb.env);
    expect(n.code, n.stderr).toBe(0);
  });
});

describe("review 1, finding 4: uninstall does not trust a forged exeDir", () => {
  it("a recorded exeDir outside <home>/bin is never deleted", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(exeInstall(standIns(sb.root)), sb.env);
    const victim = join(sb.root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "x");
    const stateFile = join(sb.home, "install-state.json");
    const state = readJson(stateFile);
    for (const e of Object.values<Doc>(state.installs)) e.exeDir = victim.replaceAll("\\", "/");
    writeFileSync(stateFile, JSON.stringify(state));
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });

  it("a folder under bin holding anything but the exes is left alone", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(exeInstall(standIns(sb.root)), sb.env);
    const [dir] = binDirs(sb.home);
    const target = join(sb.home, "bin", dir as string);
    writeFileSync(join(target, "precious.txt"), "x");
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(target, "precious.txt"))).toBe(true);
    expect(r.stdout).toMatch(/not removing/);
  });

  it("stray .tmp files do not block the prune", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(exeInstall(standIns(sb.root)), sb.env);
    const [dir] = binDirs(sb.home);
    writeFileSync(join(sb.home, "bin", dir as string, `.hook${EXT}.1.abcd1234.tmp`), "x");
    expect((await runCli(["uninstall"], sb.env)).code).toBe(0);
    expect(binDirs(sb.home)).toHaveLength(0);
  });

  it("a home inferred from the hook entries that is not the CLI default is not pruned", async () => {
    const sb = sandbox(harnessFixture);
    // A home beneath the CLI default (the sandbox home is the default itself).
    const alt = join(sb.home, "alt");
    await runCli(exeInstall(standIns(sb.root), ["--home", alt]), sb.env);
    // No --home and no SD_TEST_HOME: the home comes from the installed hook entries.
    const env = { ...sb.env, SD_TEST_HOME: "" };
    const r = await runCli(["uninstall"], env);
    expect(r.code, r.stderr).toBe(0);
    expect(binDirs(alt)).toHaveLength(1);
    expect(r.stdout).toMatch(/not removing/);
  });
});

describe("review 1, finding 5: a stale exe build is refused", () => {
  const withSources = (dir: string, sums: Record<string, string>): void =>
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sums));
  const distSums = (): Record<string, string> =>
    Object.fromEntries(BUNDLES.map((b) => [b, sha(readFileSync(join(probeRoot, "dist", b)))]));

  it("install refuses when sources.json does not match dist/*.mjs and names build:exe", async () => {
    const sb = sandbox(harnessFixture);
    const src = standIns(sb.root);
    withSources(src, { ...distSums(), "hook.mjs": "0".repeat(64) });
    const before = readFileSync(sb.settings, "utf8");
    const r = await runCli(exeInstall(src), sb.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pnpm -F @sessiondeck/probe build:exe");
    expect(readFileSync(sb.settings, "utf8")).toBe(before);
    expect(binDirs(sb.home)).toHaveLength(0);
  });

  it("install accepts matching sources.json", async () => {
    const sb = sandbox(harnessFixture);
    const src = standIns(sb.root);
    withSources(src, distSums());
    const r = await runCli(exeInstall(src), sb.env);
    expect(r.code, r.stderr).toBe(0);
  });

  it("the default dist/exe/<platform> directory needs a matching sources.json", async () => {
    const dist = join(sandbox().root, "dist");
    const dir = join(dist, "exe", PLATFORM_DIR);
    mkdirSync(dir, { recursive: true });
    for (const b of BUNDLES) writeFileSync(join(dist, b), `bundle ${b}\n`);
    for (const n of NAMES) writeFileSync(join(dir, `${n}${EXT}`), n);
    const home = join(dist, "..", "h");
    await expect(planExe(dist, home)).rejects.toBeInstanceOf(ExeError);
    await expect(planExe(dist, home)).rejects.toThrow(/build:exe/);
    withSources(dir, Object.fromEntries(BUNDLES.map((b) => [b, sha(`bundle ${b}\n`)])));
    await expect(planExe(dist, home)).resolves.toBeDefined();
    withSources(dir, Object.fromEntries(BUNDLES.map((b) => [b, sha("old")])));
    await expect(planExe(dist, home)).rejects.toThrow(/build:exe/);
  });
});
