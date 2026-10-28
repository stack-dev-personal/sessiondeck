// CLI for the R5.4 search bench; see scripts/bench-search.mjs.
import { runSearchBench, type Stats } from "./search-bench.ts";

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const r = await runSearchBench({
  sessions: arg("sessions", 2000),
  projects: arg("projects", 50),
  archived: arg("archived", 300),
  queries: arg("queries", 400),
});
const f = (s: Stats): string =>
  `p50 ${s.p50.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms  max ${s.max.toFixed(2)} ms  (n=${s.n})`;
console.log(
  `seeded ${r.options.sessions} sessions, ${r.options.projects} projects, ${r.docs} search docs in ${r.seed_ms.toFixed(0)} ms`,
);
console.log(`route (GET /search via fastify.inject): ${f(r.route)}`);
console.log(`store (Store.search):                   ${f(r.store)}`);
for (const [k, s] of Object.entries(r.perKind)) console.log(`  route ${k.padEnd(12)} ${f(s)}`);
console.log(`queries with hits: ${r.results_with_hits}/${r.route.n}`);
const worst = Math.max(r.route.p95, ...Object.values(r.perKind).map((s) => s.p95));
const ok = worst < 100;
console.log(ok ? "PASS route p95 < 100 ms overall and per class" : "FAIL some p95 >= 100 ms");
process.exit(ok ? 0 : 1);
