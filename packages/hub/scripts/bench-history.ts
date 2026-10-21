// R2.10 bench: /history/* latency on a synthetic transcript_lines table.
//   node --expose-gc scripts/bench-history.mjs [rows=100000] [bytes=5000]
// Rows are assistant lines (message id, requestId, ~bytes long) spread over 300 sessions and 120
// days, with 25% streaming repeats of an earlier id. Prints rows, first-call ms (cold index build
// from the DB), warm-call ms (aggregation only, distinct queries so the result memo is not used),
// memo-hit ms, and incremental-after-1k-new-rows ms, plus the longest event-loop stall seen.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { buildServer } from "../src/server.ts";

const rows = Number(process.argv[2] ?? 100_000);
const bytes = Number(process.argv[3] ?? 5000);
const TOKEN = "bench-token-".padEnd(24, "x");
const auth = { authorization: `Bearer ${TOKEN}` };

const dir = mkdtempSync(path.join(os.tmpdir(), "sd-bench-"));
const store = Store.open(path.join(dir, "bench.db"));
store.migrate();
const pad = "p".repeat(Math.max(0, bytes - 400));
const line = (i: number): string => {
  const id = `msg_${i - (i % 4 === 3 ? 1 : 0)}`; // every 4th row repeats the previous id
  const day = new Date(Date.UTC(2026, 0, 1) + (i % 120) * 86_400_000 + (i % 86_400) * 1000);
  return JSON.stringify({
    type: "assistant",
    timestamp: day.toISOString(),
    requestId: `req_${id}`,
    version: "2.1.0",
    message: {
      id,
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 10 + (i % 7),
        output_tokens: 100 + (i % 11) + (i % 4),
        cache_read_input_tokens: 5000,
      },
      content: [{ type: "text", text: pad }],
    },
  });
};
const insert = (from: number, to: number): void => {
  store.transaction(() => {
    for (let i = from; i < to; i++) {
      store.insertTranscriptLine({
        session_id: `sess-${i % 300}`,
        agent_id: "",
        line_no: Math.floor(i / 300),
        ts: 1_760_000_000_000 + i,
        raw: line(i),
      });
    }
  });
};
insert(0, rows);

const config = loadConfig({ HUB_TOKEN: TOKEN, HUB_PRICING_FETCH: "0", HUB_HISTORY_BURST: "1000" });
const app = buildServer({ config, store });
await app.ready(); // warm-up starts in the background, like production
let maxLag = 0;
let last = performance.now();
const timer = setInterval(() => {
  const n = performance.now();
  maxLag = Math.max(maxLag, n - last - 10);
  last = n;
}, 10);

const call = async (url: string): Promise<number> => {
  const t0 = performance.now();
  const r = await app.inject({ method: "GET", url, headers: auth });
  if (r.statusCode !== 200) throw new Error(`${url} ${r.statusCode}`);
  return performance.now() - t0;
};
const ms = (n: number): string => n.toFixed(1);

const gc = (globalThis as { gc?: () => void }).gc;
const heapMb = (): number => {
  gc?.();
  return process.memoryUsage().heapUsed / 1048576;
};
const heapBefore = heapMb();
const first = await call("/history/daily?tz=UTC");
const heapAfter = heapMb();
const stallCold = maxLag;
maxLag = 0;
const warm: number[] = [];
for (let i = 0; i < 5; i++)
  warm.push(await call(`/history/daily?tz=UTC&from=2026-01-${String(i + 1).padStart(2, "0")}`));
const warmSessions = await call("/history/sessions?tz=Asia/Tokyo&limit=100");
const memo = await call("/history/daily?tz=UTC");
insert(rows, rows + 1000);
const incr = await call("/history/daily?tz=UTC");
const incrSess = await call("/history/sessions?tz=UTC&limit=100");
clearInterval(timer);
console.log(
  JSON.stringify(
    {
      rows,
      bytes_per_row: bytes,
      heap_mb_before_cold_build: Number(heapBefore.toFixed(1)),
      heap_mb_after_cold_build: Number(heapAfter.toFixed(1)),
      heap_growth_bytes_per_row: Math.round(((heapAfter - heapBefore) * 1048576) / rows),
      gc_exposed: gc !== undefined,
      first_call_ms: Number(ms(first)),
      warm_daily_ms: warm.map((w) => Number(ms(w))),
      warm_sessions_tokyo_ms: Number(ms(warmSessions)),
      memo_hit_ms: Number(ms(memo)),
      incremental_after_1k_rows_ms: Number(ms(incr)),
      sessions_after_1k_rows_ms: Number(ms(incrSess)),
      max_event_loop_stall_ms_cold: Number(ms(stallCold)),
      max_event_loop_stall_ms_after: Number(ms(maxLag)),
    },
    null,
    1,
  ),
);
await app.close();
store.close();
rmSync(dir, { recursive: true, force: true });
