import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveHostBun } from "../scripts/bun-resolve.mjs";
import { AUTOLOAD_OFF_FLAGS } from "../scripts/exe-flags.mjs";
import { describeExe, exePathFor, probeRoot } from "./helpers.ts";

// Autoload-off control (security): Claude Code runs hooks with cwd = the user's repo, so an exe that
// autoloaded bunfig.toml would run that repo's preload as the user on every event, and .env would put
// repo variables into the hook's environment. Two layers:
//  1. the real hook, statusline and subagents exes run with cwd in a booby-trapped project and must
//     not run the preload (marker file), and must still exit 0 with the right stdout;
//  2. a tiny exe built with the SAME AUTOLOAD_OFF_FLAGS as build-exe.mjs reports the .env variable it
//     sees (none), next to a control exe built without the flags that does see the preload and .env,
//     which proves the trap works and the flags are what stop it.
// Fails instead of skipping when SD_REQUIRE_EXE=1.
const ENV_VAR = "SD_AUTOLOAD_TRAP";

let root: string;
let project: string;
let marker: string;
let work: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sd-autoload-"));
  project = join(root, "project");
  work = join(root, "work");
  mkdirSync(project);
  mkdirSync(work);
  marker = join(root, "preload-ran.txt").replaceAll("\\", "/");
  writeFileSync(
    join(project, "x.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./x.ts"]\n');
  writeFileSync(join(project, ".env"), `${ENV_VAR}=from-dotenv\n`);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "trap", scripts: { hook: "x" } }),
  );
  writeFileSync(join(project, "tsconfig.json"), "{ not valid json");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runIn(exe: string, args: string[], input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env };
    delete env[ENV_VAR];
    const child = spawn(exe, args, {
      cwd: project,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

describeExe(
  "autoload off [exe] hook, statusline and subagents ignore the cwd's bunfig and .env",
  exePathFor("hook"),
  () => {
    const input = JSON.stringify({ hook_event_name: "Stop", session_id: "trap-1", model: "M" });
    for (const name of ["hook", "statusline", "subagents"] as const) {
      it(`${name}: no preload marker, exit 0, expected stdout`, async () => {
        const home = join(work, `home-${name}`);
        const exe = exePathFor(name) as string;
        const r = await runIn(exe, ["--home", home, "--host", "t", "--sessiondeck-probe"], input);
        expect(existsSync(marker), "bunfig preload ran").toBe(false);
        expect(r.code).toBe(0);
        if (name === "statusline") expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
        else expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
      });
    }

    describe("flags pinned by build-exe.mjs (a tiny exe built with them)", () => {
      const entry = (): string => join(work, "report.ts");
      const compile = (out: string, flags: string[]): void => {
        writeFileSync(
          entry(),
          `console.log(JSON.stringify(process.env[${JSON.stringify(ENV_VAR)}] ?? null));\n`,
        );
        const { host } = resolveHostBun(probeRoot);
        const r = spawnSync(host, ["build", "--compile", ...flags, entry(), `--outfile=${out}`], {
          cwd: work,
          encoding: "utf8",
          windowsHide: true,
        });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      };
      const ext = process.platform === "win32" ? ".exe" : "";

      it("with AUTOLOAD_OFF_FLAGS: no .env variable, no preload", async () => {
        const out = join(work, `off${ext}`);
        compile(out, AUTOLOAD_OFF_FLAGS);
        const r = await runIn(out, [], "");
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout)).toBeNull();
        expect(existsSync(marker)).toBe(false);
      });

      it("control, built without the flags: sees .env and runs the preload (the trap is live)", async () => {
        const out = join(work, `on${ext}`);
        compile(out, []);
        const r = await runIn(out, [], "");
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout)).toBe("from-dotenv");
        expect(existsSync(marker)).toBe(true);
        rmSync(marker, { force: true });
      });
    });
  },
);
