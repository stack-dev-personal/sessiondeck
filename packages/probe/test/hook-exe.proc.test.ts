import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_LINE_BYTES, parseSpoolLine } from "../src/spool.ts";
import { BAD_INPUTS } from "./hook-cases.ts";
import { describeExe, fixturePerEvent, hookExePath, readSpoolLines, runHook } from "./helpers.ts";

// R1.2 and R1.3 against the Bun-compiled hook. Skips with a printed reason when not built
// (fails instead when SD_REQUIRE_EXE=1).
const exe = hookExePath ?? "";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sd-exe-robust-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describeExe("R1.2 [exe] hook never fails and never prints", hookExePath, () => {
  for (const [name, input] of BAD_INPUTS) {
    it(`exit 0, empty stdout, empty stderr: ${name}`, async () => {
      const r = await runHook(input, { home }, exe);
      expect(r.code).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    });
  }
  for (const { event, file } of fixturePerEvent()) {
    it(`exit 0, empty stdout: fixture ${event}`, async () => {
      const r = await runHook(readFileSync(file), { home }, exe);
      expect(r.code).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    });
  }
  it("spool holds only valid SpoolLines; rejected inputs are logged without payload", () => {
    const lines = readSpoolLines(join(home, "spool"));
    expect(lines.length).toBeGreaterThan(13);
    for (const l of lines) {
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(MAX_LINE_BYTES);
      expect(parseSpoolLine(l).ok).toBe(true);
    }
    const log = readFileSync(join(home, "hook-errors.log"), "utf8");
    expect(log).toMatch(/empty-stdin/);
    expect(log).toMatch(/invalid-json/);
    expect(log).not.toMatch(/xxxx/);
  });
  it("--home pointing at a file: exit 0, no stdout", async () => {
    const r = await runHook("{}", { home: join(home, "hook-errors.log") }, exe);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(0);
  });
});

describeExe("R1.3 [exe] spool under 50 parallel hooks", hookExePath, () => {
  for (let round = 1; round <= 3; round++) {
    it(`round ${round}: exact count, every line parses, unique ids, 0 corrupted`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-exe-stress-"));
      try {
        const fx = fixturePerEvent().map((f) => ({ ...f, data: readFileSync(f.file) }));
        const picks = Array.from({ length: 50 }, (_, i) => fx[i % fx.length]!);
        const expected = 50 + picks.filter((p) => p.event === "SessionStart").length;
        const runs = await Promise.all(picks.map((p) => runHook(p.data, { home: h }, exe)));
        for (const r of runs) {
          expect(r.code).toBe(0);
          expect(r.stdout.length).toBe(0);
        }
        const lines = readSpoolLines(join(h, "spool"));
        expect(lines.length).toBe(expected);
        const parsed = lines.map((l) => parseSpoolLine(l));
        expect(parsed.filter((p) => !p.ok)).toHaveLength(0);
        const ids = parsed.map((p) => (p.ok ? p.line.id : ""));
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }
});
