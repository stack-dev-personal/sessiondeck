import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeRoot, requireExe } from "./helpers.ts";
import { type Doc, harnessFixture, readJson, runCli, sandbox } from "./fixtures/sandbox.ts";

// The one install test that needs the built hook exe; it stays in the exe config (test:proc:exe).
// The stand-in install suites (install-standin*.proc.test.ts) run in test:proc.
const WIN = process.platform === "win32";
const EXT = WIN ? ".exe" : "";
const PLATFORM_DIR = WIN ? "windows-x64" : "linux-x64";
const NAMES = ["hook", "statusline", "subagents"];
const SOURCES = "sources.json";
const MARKER = "--sessiondeck-probe";
const isOurs = (h: Doc): boolean => Array.isArray(h?.args) && h.args.includes(MARKER);
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function standIns(root: string, tag = "a"): string {
  const dir = join(root, `exe-src-${tag}`);
  mkdirSync(dir, { recursive: true });
  for (const n of NAMES)
    writeFileSync(
      join(dir, `${n}${EXT}`),
      `stand-in ${n} ${tag}
`,
    );
  return dir;
}

const exeInstall = (src: string): string[] => ["install", "--runtime", "exe", "--exe-dir", src];

describe("probe install with the real hook exe (R1.8, R1.10, R1.1)", () => {
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
