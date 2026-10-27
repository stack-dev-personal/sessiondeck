import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realResolve, realSlash } from "../src/install/real-path.ts";
import { resolveHostName } from "../src/host.ts";
import { probeRoot, requireExe } from "./helpers.ts";
import {
  type Doc,
  harnessFixture,
  readJson,
  readText,
  runCli,
  sandbox,
} from "./fixtures/sandbox.ts";

const WIN = process.platform === "win32";
const EXT = WIN ? ".exe" : "";
const PLATFORM_DIR = WIN ? "windows-x64" : "linux-x64";
const NAMES = ["hook", "statusline", "subagents"];
const SOURCES = "sources.json";
const MARKER = "--sessiondeck-probe";
const isOurs = (h: Doc): boolean => Array.isArray(h?.args) && h.args.includes(MARKER);
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Small stand-in files named like the real exes: enough for the copy, hash and settings logic. */
function standIns(root: string, tag = "a"): string {
  const dir = join(root, `exe-src-${tag}`);
  mkdirSync(dir, { recursive: true });
  for (const n of NAMES) writeFileSync(join(dir, `${n}${EXT}`), `stand-in ${n} ${tag}\n`);
  return dir;
}

const binDirs = (home: string): string[] =>
  existsSync(join(home, "bin")) ? readdirSync(join(home, "bin")) : [];

const exeInstall = (src: string, extra: string[] = []): string[] => [
  "install",
  "--runtime",
  "exe",
  "--exe-dir",
  src,
  ...extra,
];

describe("probe install, exe form (R1.8, R1.10, R1.1)", () => {
  it("upgrades a Node-form install to the exe form; harness hooks (even ones named hook.exe) stay byte-identical", async () => {
    const sb = sandbox(harnessFixture);
    const seed = readJson(sb.settings);
    seed.hooks.Stop.push({
      hooks: [{ type: "command", command: "C:/tools/hook.exe", args: ["--keep"] }],
    });
    writeFileSync(sb.settings, `${JSON.stringify(seed, null, 2)}\n`);
    const foreign = readJson(sb.settings);
    const src = standIns(sb.root);

    expect((await runCli(["install", "--runtime", "node"], sb.env)).code).toBe(0);
    const nodeForm = readJson(sb.settings);
    expect(nodeForm.hooks.Stop.flatMap((g: Doc) => g.hooks).find(isOurs).command).toBe("node");

    const r = await runCli(exeInstall(src, ["--statusline=replace"]), sb.env);
    expect(r.code, r.stderr).toBe(0);
    const after = readJson(sb.settings);
    const exeDir = realSlash(join(sb.home, "bin"));
    for (const [event, groups] of Object.entries<Doc[]>(foreign.hooks)) {
      expect(after.hooks[event].filter((g: Doc) => !g.hooks.some(isOurs))).toEqual(groups);
    }
    for (const event of Object.keys(after.hooks)) {
      const ours = after.hooks[event].flatMap((g: Doc) => g.hooks).filter(isOurs);
      expect(ours).toHaveLength(1);
      expect(ours[0].command).toMatch(
        new RegExp(`^${exeDir}/[0-9a-f]{12}/hook${EXT}$`.replace(".", "\\.")),
      );
      expect(ours[0].args).toEqual([
        "--home",
        realSlash(sb.home),
        "--host",
        resolveHostName(),
        MARKER,
      ]);
      expect(ours[0].timeout).toBe(5);
    }
    expect(after.statusLine.command).toBe(
      `${after.hooks.Stop.flatMap((g: Doc) => g.hooks)
        .find(isOurs)
        .command.replace(
          /hook(\.exe)?$/,
          `statusline${EXT}`,
        )} --home ${realSlash(sb.home)} --host ${resolveHostName()} ${MARKER}`,
    );
    expect(after.subagentStatusLine.command).toContain(`/subagents${EXT} --home `);
    expect(readText(sb.settings)).not.toContain("\\\\");
    expect(readJson(join(sb.home, "install-state.json")).installs).toBeDefined();
  });

  it("is idempotent: a second and third run give an identical settings file, state and one exe dir", async () => {
    const sb = sandbox(harnessFixture);
    const src = standIns(sb.root);
    expect((await runCli(exeInstall(src), sb.env)).code).toBe(0);
    const once = readText(sb.settings);
    const state = readText(join(sb.home, "install-state.json"));
    await runCli(exeInstall(src), sb.env);
    await runCli(exeInstall(src), sb.env);
    expect(readText(sb.settings)).toBe(once);
    expect(readText(join(sb.home, "install-state.json"))).toBe(state);
    expect(binDirs(sb.home)).toHaveLength(1);
  });

  it("--runtime node round trip: node, exe, node gives the first settings back and records the runtime", async () => {
    const sb = sandbox(harnessFixture);
    const src = standIns(sb.root);
    const stateOf = (): Doc =>
      Object.values<Doc>(readJson(join(sb.home, "install-state.json")).installs)[0];
    await runCli(["install", "--runtime", "node"], sb.env);
    const first = readText(sb.settings);
    expect(stateOf().runtime).toBe("node");
    await runCli(exeInstall(src), sb.env);
    expect(readText(sb.settings)).not.toBe(first);
    expect(stateOf().runtime).toBe("exe");
    expect(binDirs(sb.home)).toHaveLength(1);
    await runCli(["install", "--runtime", "node"], sb.env);
    expect(readText(sb.settings)).toBe(first);
    expect(stateOf().runtime).toBe("node");
    expect(binDirs(sb.home)).toHaveLength(0);
  });

  it("a changed exe gets a new directory and the old one (ours, recorded) is removed", async () => {
    const sb = sandbox(harnessFixture);
    await runCli(exeInstall(standIns(sb.root, "a")), sb.env);
    const [first] = binDirs(sb.home);
    const r = await runCli(exeInstall(standIns(sb.root, "b")), sb.env);
    expect(r.code, r.stderr).toBe(0);
    const dirs = binDirs(sb.home);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toBe(first);
  });

  it("refuses when the exe source is missing: names build:exe, exits non-zero, writes nothing", async () => {
    const sb = sandbox();
    const empty = join(sb.root, "no-exes");
    mkdirSync(empty);
    const r = await runCli(exeInstall(empty), sb.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pnpm -F @sessiondeck/probe build:exe");
    expect(existsSync(sb.settings)).toBe(false);
    expect(existsSync(join(sb.home, "bin"))).toBe(false);
    expect(existsSync(join(sb.home, "probe.json"))).toBe(false);
    expect(existsSync(join(sb.home, "install-state.json"))).toBe(false);

    const sb2 = sandbox(harnessFixture);
    const before = readText(sb2.settings);
    expect((await runCli(exeInstall(empty), sb2.env)).code).toBe(1);
    expect(readText(sb2.settings)).toBe(before);
  });

  it("installs the exes under the probe home with matching SHA-256 and no temp files left", async () => {
    const sb = sandbox(harnessFixture);
    const src = standIns(sb.root);
    expect((await runCli(exeInstall(src), sb.env)).code).toBe(0);
    const [dir] = binDirs(sb.home);
    const target = join(realResolve(sb.home), "bin", dir as string);
    expect(readdirSync(target).sort()).toEqual(NAMES.map((n) => `${n}${EXT}`).sort());
    for (const n of NAMES) {
      expect(sha(join(target, `${n}${EXT}`))).toBe(sha(join(src, `${n}${EXT}`)));
      if (!WIN) expect(statSync(join(target, n)).mode & 0o777).toBe(0o755);
    }
    if (!WIN) expect(statSync(target).mode & 0o777).toBe(0o700);
    const cmd = readJson(sb.settings)
      .hooks.Stop.flatMap((g: Doc) => g.hooks)
      .find(isOurs).command;
    expect(cmd).toBe(`${realSlash(target)}/hook${EXT}`);
  });

  it("uninstall removes the exe-form entries and the exe directory, restoring the fixture", async () => {
    const sb = sandbox(harnessFixture);
    const original = readText(sb.settings);
    await runCli(exeInstall(standIns(sb.root)), sb.env);
    const r = await runCli(["uninstall"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(sb.settings)).toEqual(JSON.parse(original));
    expect(binDirs(sb.home)).toHaveLength(0);
  });

  it("uninstall without install state still removes the exe form (marker only)", async () => {
    const sb = sandbox(harnessFixture);
    const original = readText(sb.settings);
    await runCli(exeInstall(standIns(sb.root)), sb.env);
    writeFileSync(join(sb.home, "install-state.json"), "garbage");
    await runCli(["uninstall"], sb.env);
    expect(readJson(sb.settings)).toEqual(JSON.parse(original));
  });

  it("rejects an unknown --runtime", async () => {
    const r = await runCli(["install", "--runtime", "deno"], sandbox().env);
    expect(r.code).toBe(2);
  });

  const realDir = join(probeRoot, "dist", "exe", PLATFORM_DIR);
  const realHook = join(realDir, `hook${EXT}`);
  const haveReal = existsSync(realHook) && existsSync(join(realDir, SOURCES));
  if (!haveReal) {
    process.stderr.write(
      `skipping the real-exe install test: ${realHook} is missing (run pnpm -F @sessiondeck/probe build:exe)
`,
    );
  }
  if (!haveReal && requireExe) {
    it("the real exe is built (SD_REQUIRE_EXE=1)", () => {
      throw new Error(`${realHook} missing; run pnpm -F @sessiondeck/probe build:exe`);
    });
  }
  // Only the hook is real (about 110 MB, hard-linked into the source dir so nothing extra is copied
  // there; the install itself copies it once into the sandbox, which is deleted afterwards). The
  // other two are stand-ins; the real sources.json still has to match dist/*.mjs.
  it.skipIf(!haveReal)(
    "install copies the built hook exe and the installed hook exe runs silently",
    async () => {
      const sb = sandbox(harnessFixture);
      const src = standIns(sb.root);
      rmSync(join(src, `hook${EXT}`));
      try {
        linkSync(realHook, join(src, `hook${EXT}`));
      } catch {
        copyFileSync(realHook, join(src, `hook${EXT}`)); // different volume: fall back to a copy
      }
      copyFileSync(join(realDir, SOURCES), join(src, SOURCES));
      const r = await runCli(exeInstall(src), sb.env);
      expect(r.code, r.stderr).toBe(0);
      const hook = readJson(sb.settings)
        .hooks.Stop.flatMap((g: Doc) => g.hooks)
        .find(isOurs);
      expect(sha(hook.command)).toBe(sha(realHook));
      const run = spawnSync(hook.command, hook.args, {
        input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }),
        windowsHide: true,
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    },
  );
});
