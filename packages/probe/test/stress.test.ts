import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvelopeSchema } from "@sessiondeck/contract";
import { fixturePerEvent, readSpoolLines, runHook } from "./helpers.ts";

const PARALLEL = 50;

describe("R1.3 spool under 50 parallel hooks", () => {
  for (let round = 1; round <= 3; round++) {
    it(`round ${round}: 0 corrupted lines, unique ids, strictly increasing unique seq`, async () => {
      const home = mkdtempSync(join(tmpdir(), "sd-stress-"));
      try {
        const fixtures = fixturePerEvent().map((f) => ({ ...f, data: readFileSync(f.file) }));
        const picks = Array.from({ length: PARALLEL }, (_, i) => fixtures[i % fixtures.length]!);
        const expected = PARALLEL + picks.filter((p) => p.event === "SessionStart").length;
        const runs = await Promise.all(
          picks.map((p) => runHook(p.data, { SESSIONDECK_HOME: home })),
        );
        for (const r of runs) {
          expect(r.code).toBe(0);
          expect(r.stdout.length).toBe(0);
        }
        const lines = readSpoolLines(join(home, "spool"));
        expect(lines.length).toBe(expected);
        const envs = lines.map((l) => EnvelopeSchema.parse(JSON.parse(l)));
        expect(new Set(envs.map((e) => e.id)).size).toBe(envs.length);
        const seqs = envs.map((e) => e.seq);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
