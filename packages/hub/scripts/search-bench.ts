// R5.4 search latency bench (shared by scripts/bench-search.mjs and test/search.R5.4.bench.test.ts).
//
// Data size: the plan expects about 300 archived harness captures plus live history; the bench
// seeds 2,000 sessions (about x6 margin) over 50 projects. The contract fixtures carry scrubbed
// text ("<TEXT 1792>"), so the texts here are generated from a fixed 3,000-word vocabulary with a
// skewed (Zipf-like) word choice, at the sizes the fixtures show: names of 3 to 6 words, prompts of
// about 200 characters, last assistant messages of about 1,800 characters (fixture "<TEXT 1792>").
// Everything is deterministic (fixed PRNG seed), so runs differ only by machine noise.
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { rowOf } from "../src/ingest/ingestor.ts";
import { buildServer } from "../src/server.ts";

export interface BenchOptions {
  sessions: number;
  projects: number;
  archived: number;
  queries: number;
  file: boolean;
}
export const DEFAULTS: BenchOptions = {
  sessions: 2000,
  projects: 50,
  archived: 300,
  queries: 200,
  file: true,
};

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}
export interface BenchResult {
  options: BenchOptions;
  seed_ms: number;
  docs: number;
  route: Stats;
  store: Stats;
  perKind: Record<string, Stats>;
  results_with_hits: number;
}

const TOKEN = "bench-token-".padEnd(24, "x");

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vocabulary(rand: () => number): string[] {
  const syl = [
    "ka",
    "lo",
    "mi",
    "ren",
    "tu",
    "va",
    "sor",
    "den",
    "pi",
    "qua",
    "bel",
    "cor",
    "fan",
    "gri",
    "hy",
    "jo",
    "lum",
    "nex",
    "ox",
    "pra",
  ];
  const words = new Set<string>();
  while (words.size < 3000) {
    const n = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += syl[Math.floor(rand() * syl.length)];
    words.add(w);
  }
  return [...words];
}

export function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0 };
}

export async function runSearchBench(opts: Partial<BenchOptions> = {}): Promise<BenchResult> {
  const o = { ...DEFAULTS, ...opts };
  const rand = rng(20261027);
  const vocab = vocabulary(rand);
  const word = (): string => vocab[Math.floor(Math.pow(rand(), 2.2) * vocab.length)]!;
  const text = (chars: number): string => {
    let s = "";
    while (s.length < chars) s += `${word()} `;
    return s.trim();
  };

  const dir = o.file ? mkdtempSync(path.join(os.tmpdir(), "sd-bench-search-")) : null;
  const store = Store.open(dir ? path.join(dir, "bench.db") : ":memory:");
  try {
    store.migrate();
    const t0 = performance.now();
    const BASE = Date.parse("2026-01-01T00:00:00Z");
    store.transaction(() => {
      for (let i = 0; i < o.sessions; i++) {
        const archived = i < o.archived;
        const proj = i % o.projects;
        const nameWords = 3 + Math.floor(rand() * 4);
        const snap: SessionSnapshot = {
          ...createSnapshot({
            session_id: `sess-${i.toString().padStart(5, "0")}`,
            host: "laptop",
            cwd: `/home/u/code/proj-${proj}-${word()}`,
            ts: BASE + i * 60_000,
          }),
          session_name:
            (i % 7 === 0 ? `P${1 + (i % 9)} ` : "") +
            Array.from({ length: nameWords }, word).join(" "),
          last_prompt: text(200),
          last_assistant_message: text(1800),
          state: archived ? "archived" : i % 5 === 0 ? "working" : "ended",
          last_event_at: BASE + i * 60_000,
        } as SessionSnapshot;
        if (archived) (snap as unknown as Record<string, unknown>)["outcome"] = text(300);
        const row = rowOf(snap);
        // Project dirs repeat so there are `projects` projects.
        row.project_dir = `/home/u/code/proj-${proj}`;
        store.upsertSession(row);
      }
    });
    const seed_ms = performance.now() - t0;
    const docs = (store.db.prepare("SELECT COUNT(*) AS n FROM search_docs").get() as { n: number })
      .n;

    // Query mix: prefix, single word, multi-token, no-hit, phase label, empty.
    const queries: { kind: string; q: string }[] = [];
    for (let i = 0; i < o.queries; i++) {
      const w = word();
      switch (i % 6) {
        case 0:
          queries.push({ kind: "prefix", q: w.slice(0, 3) });
          break;
        case 1:
          queries.push({ kind: "word", q: w });
          break;
        case 2:
          queries.push({ kind: "multi", q: `${word()} ${word()}` });
          break;
        case 3:
          queries.push({ kind: "no-hit", q: `zz${i}qx nomatch` });
          break;
        case 4:
          queries.push({ kind: "multi-prefix", q: `${word()} ${word()} ${word().slice(0, 2)}` });
          break;
        default:
          queries.push({
            kind: i % 12 === 5 ? "phase" : "empty",
            q: i % 12 === 5 ? `p${1 + (i % 9)}` : "",
          });
      }
    }

    const config = loadConfig({
      HUB_TOKEN: TOKEN,
      HUB_READ_RATE: "100000",
      HUB_READ_BURST: "100000",
    });
    const app = buildServer({ config, store, logStream: { write: () => {} } });
    await app.ready();
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      const hit = (q: string) =>
        app.inject({ method: "GET", url: `/search?q=${encodeURIComponent(q)}`, headers: auth });
      for (const w of queries.slice(0, 20)) {
        await hit(w.q);
        store.search(w.q, 20);
      }
      const route: number[] = [];
      const st: number[] = [];
      const byKind = new Map<string, number[]>();
      let withHits = 0;
      for (const { kind, q } of queries) {
        const a = performance.now();
        const r = await hit(q);
        const ms = performance.now() - a;
        route.push(ms);
        const list = byKind.get(kind) ?? [];
        list.push(ms);
        byKind.set(kind, list);
        const body = r.json() as { results: unknown[] };
        if (r.statusCode !== 200) throw new Error(`search returned ${r.statusCode}`);
        if (body.results.length > 0) withHits++;
        const b = performance.now();
        store.search(q, 20);
        st.push(performance.now() - b);
      }
      return {
        options: o,
        seed_ms,
        docs,
        route: stats(route),
        store: stats(st),
        perKind: Object.fromEntries([...byKind].map(([k, v]) => [k, stats(v)])),
        results_with_hits: withHits,
      };
    } finally {
      await app.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // closed by app.close
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
