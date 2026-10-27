import { describe, expect, it } from "vitest";
import { runSearchBench } from "../scripts/search-bench.ts";

describe("R5.4 search latency", () => {
  it("p95 < 100 ms at the route on 2,000 sessions / 50 projects (x6 margin on the expected data size)", async () => {
    const r = await runSearchBench();
    console.log(
      `search bench: docs=${r.docs} route p50=${r.route.p50.toFixed(2)} p95=${r.route.p95.toFixed(2)} max=${r.route.max.toFixed(2)} ms; store p50=${r.store.p50.toFixed(2)} p95=${r.store.p95.toFixed(2)} max=${r.store.max.toFixed(2)} ms`,
    );
    expect(r.docs).toBeGreaterThanOrEqual(2000 + 50);
    expect(r.results_with_hits).toBeGreaterThan(100); // the mix is not all misses
    expect(r.route.n).toBe(200);
    expect(r.route.p95).toBeLessThan(100);
    expect(r.store.p95).toBeLessThan(100);
  }, 120_000);
});
