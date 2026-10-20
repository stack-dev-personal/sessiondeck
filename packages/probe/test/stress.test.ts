import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpoolLine } from "../src/spool.ts";
import { fixturePerEvent, readSpoolLines, runHook } from "./helpers.ts";

const PARALLEL = 50;

describe("R1.3 spool under 50 parallel hooks", () => {
  for (let round = 1; round <= 3; round++) {
    it(`round ${round}: exact count, every line parses as SpoolLine, unique ids, 0 corrupted lines`, async () => {
      const home = mkdtempSync(join(tmpdir(), "sd-stress-"));
      try {
        const fixtures = fixturePerEvent().map((f) => ({ ...f, data: readFileSync(f.file) }));
        const picks = Array.from({ length: PARALLEL }, (_, i) => fixtures[i % fixtures.length]!);
        const expected = PARALLEL + picks.filter((p) => p.event === "SessionStart").length;
        const runs = await Promise.all(picks.map((p) => runHook(p.data, { home })));
        for (const r of runs) {
          expect(r.code).toBe(0);
          expect(r.stdout.length).toBe(0);
        }
        const lines = readSpoolLines(join(home, "spool"));
        expect(lines.length).toBe(expected);
        const parsed = lines.map((l) => parseSpoolLine(l));
        expect(parsed.filter((p) => !p.ok)).toHaveLength(0);
        const ids = parsed.map((p) => (p.ok ? p.line.id : ""));
        expect(new Set(ids).size).toBe(ids.length);
        for (const l of lines) expect("seq" in JSON.parse(l)).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
