import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { usedBytes } from "../lib/capture-budget.mjs";
import {
  ERROR_LOG_NAME,
  HOOK_MAX_FILES_PER_DIR,
  OUT_MAX_TOTAL_BYTES,
  STATUSLINE_ERROR_TEXT,
  STATUSLINE_FULL_TEXT,
  STATUSLINE_TEXT,
  USAGE_LOG_NAME,
} from "../lib/capture-config.mjs";
import { captureOnce, mayUseDir } from "../lib/capture-core.mjs";
import { DEPLOY_FILES } from "../lib/install-config.mjs";
import {
  CAPTURE_SCRIPT,
  cleanupTempDirs,
  makeTempDir,
  runHookInProcess,
  runScript,
} from "./helpers";

afterAll(cleanupTempDirs);

const NOW = 1_700_000_000_000;
const stop = () => JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
const hook = (out: string) =>
  captureOnce({ mode: "hook", out, text: stop(), truncated: false, now: NOW });
const MODES = [
  ["hook", []],
  ["statusline", ["--statusline"]],
  ["subagents", ["--subagents"]],
] as const;

describe("the hook entry survives broken lib files (finding 6)", () => {
  /** A deployed-copy lookalike: the entry file, and lib files made by `make`. */
  function entryOnly(make?: (name: string) => string | undefined): string {
    const dir = makeTempDir();
    copyFileSync(CAPTURE_SCRIPT, join(dir, "capture-fixtures.mjs"));
    if (make) {
      mkdirSync(join(dir, "lib"));
      for (const file of DEPLOY_FILES.filter((f) => f.startsWith("lib/"))) {
        const body = make(file);
        if (body !== undefined) writeFileSync(join(dir, file), body);
      }
    }
    return join(dir, "capture-fixtures.mjs");
  }

  it.concurrent.each(MODES)("entry file alone, mode %s: exit 0, no output", async (_m, flags) => {
    const sandbox = makeTempDir();
    const script = entryOnly();
    const out = join(sandbox, "out");
    const r = await runScript(script, [...flags, "--out", out], { sandbox, input: stop() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(existsSync(out)).toBe(false);
  });

  it.concurrent.each(MODES)(
    "every lib file throws at import, mode %s: exit 0, no output",
    async (_m, flags) => {
      const sandbox = makeTempDir();
      const script = entryOnly(() => 'throw new Error("boom");\n');
      const r = await runScript(script, [...flags, "--out", join(sandbox, "out")], {
        sandbox,
        input: stop(),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    },
  );
});

describe("the budget stop is visible and one line is logged (finding 7)", () => {
  it("a usage line above the whole budget is ignored, so recording continues", async () => {
    const out = join(makeTempDir(), "out");
    mkdirSync(out);
    writeFileSync(join(out, USAGE_LOG_NAME), `1e308\n${OUT_MAX_TOTAL_BYTES + 1}\n-5\nabc\n`);
    expect(await usedBytes(out)).toBe(0);
    expect(await hook(out)).toEqual({ full: false });
    expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
  });

  it("a full budget logs exactly one line however many payloads are refused", async () => {
    const out = join(makeTempDir(), "out");
    mkdirSync(out);
    writeFileSync(join(out, USAGE_LOG_NAME), `${OUT_MAX_TOTAL_BYTES}\n`);
    for (let i = 0; i < 3; i++) expect(await hook(out)).toEqual({ full: true });
    const lines = readFileSync(join(out, ERROR_LOG_NAME), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ full-budget FULL$/);
    expect(existsSync(join(out, "Stop"))).toBe(false);
  });

  it("a per-event cap logs once and reports full", async () => {
    const out = join(makeTempDir(), "out");
    mkdirSync(join(out, "Stop"), { recursive: true });
    for (let i = 0; i < HOOK_MAX_FILES_PER_DIR; i++)
      writeFileSync(join(out, "Stop", `f${i}.json`), "{}");
    expect(await hook(out)).toEqual({ full: true });
    expect(await hook(out)).toEqual({ full: true });
    const log = readFileSync(join(out, ERROR_LOG_NAME), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain(" full-cap-Stop ");
    expect(readdirSync(join(out, "Stop"))).toHaveLength(HOOK_MAX_FILES_PER_DIR);
  });

  it("the status line text changes once recording has stopped; hook mode stays silent", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const flags = ["--out", out];
    const first = await runHookInProcess(CAPTURE_SCRIPT, ["--statusline", ...flags], {
      sandbox,
      input: JSON.stringify({ session_id: "s1", model: { id: "m" } }),
    });
    expect(first.stdout).toBe(`${STATUSLINE_TEXT}\n`);
    writeFileSync(join(out, USAGE_LOG_NAME), `${OUT_MAX_TOTAL_BYTES}\n`);
    const status = await runHookInProcess(CAPTURE_SCRIPT, ["--statusline", ...flags], {
      sandbox,
      input: JSON.stringify({ session_id: "s2", model: { id: "m" } }),
    });
    expect(status.code).toBe(0);
    expect(status.stdout).toBe(`${STATUSLINE_FULL_TEXT}\n`);
    const quiet = await runHookInProcess(CAPTURE_SCRIPT, flags, { sandbox, input: stop() });
    expect(quiet.code).toBe(0);
    expect(quiet.stdout + quiet.stderr).toBe("");
  });

  it("the status line says error, and nothing else, when recording failed (finding S5)", async () => {
    const sandbox = makeTempDir();
    const notADir = join(sandbox, "a-file");
    writeFileSync(notADir, "x");
    const input = JSON.stringify({ session_id: "s1", model: { id: "m" } });
    const runs = [
      ["--statusline", "--out"],
      ["--statusline", "--out", join(notADir, "out")],
    ];
    for (const args of runs) {
      const r = await runHookInProcess(CAPTURE_SCRIPT, args, { sandbox, input });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${STATUSLINE_ERROR_TEXT}\n`);
      expect(r.stderr).toBe("");
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "raw payload modes (finding S4; Windows uses inherited ACLs, not modes)",
  () => {
    it("creates the out dir, event dirs and payload files owner-only", async () => {
      const out = join(makeTempDir(), "nested", "out");
      await hook(out);
      const modeOf = (p: string) => statSync(p).mode & 0o777;
      expect(modeOf(out)).toBe(0o700);
      expect(modeOf(join(out, "Stop"))).toBe(0o700);
      const file = readdirSync(join(out, "Stop"))[0]!;
      expect(modeOf(join(out, "Stop", file))).toBe(0o600);
    });
  },
);

describe("the nested .gitignore is restored (finding 8)", () => {
  it.each([
    ["", "empty"],
    ["# nothing\n", "edited"],
  ])("an %2$s file is rewritten to *", async (body) => {
    const out = join(makeTempDir(), "out");
    await hook(out);
    writeFileSync(join(out, ".gitignore"), body);
    await hook(out);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toBe("*\n");
  });
});

describe("mayUseDir only treats a missing root as usable (R0.5)", () => {
  const failWith = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));

  it("allows a missing root", async () => {
    expect(await mayUseDir("/x", "d", failWith("ENOENT"))).toBe(true);
  });

  it.each(["ENOTDIR", "EACCES"])("rethrows %s so the caller logs it", async (code) => {
    await expect(mayUseDir("/x", "d", failWith(code))).rejects.toMatchObject({ code });
  });

  it("allows a known name and refuses a new one when full", async () => {
    const names = Array.from({ length: 10_000 }, (_, i) => `n${i}`);
    expect(await mayUseDir("/x", "n1", () => Promise.resolve(names))).toBe(true);
    expect(await mayUseDir("/x", "new", () => Promise.resolve(names))).toBe(false);
  });
});
