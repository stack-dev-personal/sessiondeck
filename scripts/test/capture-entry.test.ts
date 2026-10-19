import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEPLOY_FILES } from "../lib/install-config.mjs";
import { CAPTURE_SCRIPT, cleanupTempDirs, makeTempDir, runScript, SCRIPTS_DIR } from "./helpers";

afterAll(cleanupTempDirs);

// Real node processes only: these prove the entry file end to end. They live apart from
// capture-fixtures.test.ts so the two slow files run in parallel (R0.5 time budget).

function captureSpawned(sandbox: string, out: string, input: string, flags: string[] = []) {
  return runScript(CAPTURE_SCRIPT, [...flags, "--out", out], { input, sandbox });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("real hook processes", () => {
  it("honours SESSIONDECK_CAPTURE_DIR when --out is absent (real process passes process.env)", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "envout-real");
    const r = await runScript(CAPTURE_SCRIPT, [], {
      sandbox,
      input: '{"hook_event_name":"Stop","session_id":"a"}',
      env: { SESSIONDECK_CAPTURE_DIR: out },
    });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
  });

  it("16 concurrent real hook processes produce 16 intact distinct files", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const payloads = Array.from({ length: 16 }, (_, i) => ({
      hook_event_name: "PostToolUse",
      session_id: "same-session",
      i,
    }));
    const results = await Promise.all(
      payloads.map((p) => captureSpawned(sandbox, out, JSON.stringify(p))),
    );
    expect(results.every((r) => r.code === 0 && r.stdout === "")).toBe(true);
    const dir = join(out, "PostToolUse");
    const seen = readdirSync(dir)
      .map((f) => (readJson(join(dir, f)) as { i: number }).i)
      .sort((a, b) => a - b);
    expect(seen).toEqual(payloads.map((p) => p.i));
  });
});

/** A copy of the deployable hook closure, as the installer would lay it out. */
function copyHook(dest: string): string {
  for (const file of DEPLOY_FILES) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    copyFileSync(join(SCRIPTS_DIR, file), join(dest, file));
  }
  return join(dest, "capture-fixtures.mjs");
}

describe.skipIf(process.platform !== "win32")(
  "entry point under non-canonical invocation paths (win32 only: junctions and case-insensitive paths)",
  () => {
    const payload = '{"hook_event_name":"Stop","session_id":"a"}';

    it("runs and writes a file when started through a lowercased path", async () => {
      const sandbox = makeTempDir();
      const out = join(sandbox, "out");
      const lowered = CAPTURE_SCRIPT.toLowerCase();
      expect(lowered).not.toBe(CAPTURE_SCRIPT);
      const r = await runScript(lowered, ["--out", out], { input: payload, sandbox });
      expect(r.code).toBe(0);
      expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
    });

    it("runs and writes a file when started through a junction to the deploy dir", async () => {
      const sandbox = makeTempDir();
      const out = join(sandbox, "out");
      const real = join(sandbox, "real-deploy");
      const link = join(sandbox, "link-deploy");
      copyHook(real);
      symlinkSync(real, link, "junction");
      try {
        const r = await runScript(join(link, "capture-fixtures.mjs"), ["--out", out], {
          input: payload,
          sandbox,
        });
        expect(r.code).toBe(0);
        expect(r.stdout + r.stderr).toBe("");
        expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
      } finally {
        rmSync(link, { force: true }); // removes the junction itself, not its target
      }
    });
  },
);
