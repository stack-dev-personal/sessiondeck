import { describe, expect, it } from "vitest";
import { runSearchBench } from "../scripts/search-bench.ts";

// Functional smoke for R5.4 in the default suite: small seed, correct results, no hard latency
// threshold (a very loose ceiling only catches a hang). The p95 < 100 ms proof is `pnpm test:bench`.
describe("R5.4 search smoke", () => {
  it("serves every query class on a small corpus with hits", async () => {
    const r = await runSearchBench({ sessions: 150, projects: 6, archived: 20, queries: 55 });
    console.log(`search smoke: route p95=${r.route.p95.toFixed(2)} ms (not asserted)`);
    expect(r.docs).toBeGreaterThanOrEqual(150);
    expect(r.results_with_hits).toBeGreaterThan(10);
    for (const k of ["char1", "common-word", "stop-prefix", "common-multi"])
      expect(r.perKind[k], k).toBeDefined();
    expect(r.route.max).toBeLessThan(1000);
  }, 60_000);
});
