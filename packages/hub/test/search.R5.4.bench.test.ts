import { describe, expect, it } from "vitest";
import { runSearchBench } from "../scripts/search-bench.ts";

describe("R5.4 search latency", () => {
  it("route p95 < 100 ms overall and for every query class (incl. 1-character and stopword queries) on 2,000 sessions / 50 projects", async () => {
    const r = await runSearchBench();
    console.log(
      `search bench: docs=${r.docs} route p50=${r.route.p50.toFixed(2)} p95=${r.route.p95.toFixed(2)} max=${r.route.max.toFixed(2)} ms; store p50=${r.store.p50.toFixed(2)} p95=${r.store.p95.toFixed(2)} max=${r.store.max.toFixed(2)} ms (store figure reported, not asserted)`,
    );
    for (const [k, v] of Object.entries(r.perKind))
      console.log(
        `  ${k.padEnd(13)} n=${v.n} p50=${v.p50.toFixed(2)} p95=${v.p95.toFixed(2)} max=${v.max.toFixed(2)}`,
      );
    expect(r.docs).toBeGreaterThanOrEqual(2000 + 50);
    expect(r.results_with_hits).toBeGreaterThan(100); // the mix is not all misses
    expect(r.route.n).toBe(400);
    expect(r.route.p95).toBeLessThan(100);
    for (const k of ["char1", "common-word", "stop-prefix", "common-multi"])
      expect(r.perKind[k], k).toBeDefined();
    for (const [k, v] of Object.entries(r.perKind)) expect(v.p95, k).toBeLessThan(100);
  }, 120_000);
});
