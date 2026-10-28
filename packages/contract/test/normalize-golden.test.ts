import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTranscript } from "../src/normalize";
import {
  GOLDEN_DIR,
  fixtureNames,
  goldenText,
  loadTranscript,
  optionsOf,
} from "./normalize-helpers";

// Regenerate after an intended change: `pnpm -F @sessiondeck/contract exec vitest run test/normalize-golden.test.ts -u`
// and review the diff. Without -u any difference fails the test.
describe("normalize golden (R4.1)", () => {
  it("covers the five fixture transcripts", () => {
    expect(fixtureNames()).toHaveLength(5);
  });

  it.each(fixtureNames().map((n) => [n]))("%s matches its golden file", async (name) => {
    const fx = loadTranscript(name);
    const messages = normalizeTranscript(fx.main, optionsOf(fx));
    await expect(goldenText(messages)).toMatchFileSnapshot(join(GOLDEN_DIR, `${name}.json`));
  });

  it("is deterministic across runs", () => {
    const fx = loadTranscript("01-subagents");
    const a = JSON.stringify(normalizeTranscript(fx.main, optionsOf(fx)));
    const b = JSON.stringify(normalizeTranscript(fx.main, optionsOf(fx)));
    expect(a).toBe(b);
  });
});
