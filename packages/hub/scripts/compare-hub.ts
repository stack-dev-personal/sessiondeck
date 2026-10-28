// Hub half of the ccusage comparison (bundled and imported by ccusage-compare.mjs). Loads a
// CLAUDE_CONFIG_DIR-style tree into an in-memory hub through the real POST /ingest path, then
// reads the cost history back over REST with a bearer token.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { PricingProvider, loadPricing } from "../src/pricing/loader.ts";
import { PricingTable, type ModelPricing } from "../src/pricing/pricing.ts";
import { buildServer } from "../src/server.ts";
import {
  createUniqueHash,
  makeDayFormatter,
  parseUsageLine,
  type DailyUsage,
  type SessionUsage,
} from "../src/usage/usage.ts";

const TOKEN = "compare-harness-token";
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(n: number): string {
  let s = "";
  for (let i = 0, v = n; i < 25; i++, v = Math.floor(v / 32)) s = B32[v % 32] + s;
  return `0${s}`;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(path.join(dir, e.name))
      : e.name.endsWith(".jsonl")
        ? [path.join(dir, e.name)]
        : [],
  );
}

/** projects/<p>/<session>.jsonl -> (session, ''); projects/<p>/<session>/subagents/<f>.jsonl -> (session, f). */
function locate(projects: string, file: string): { session: string; agent: string } {
  const parts = path.relative(projects, file).split(path.sep);
  const base = (parts.at(-1) ?? "").replace(/\.jsonl$/, "");
  if (parts.length === 2) return { session: base, agent: "" };
  if (parts.at(-2) === "subagents" && parts.length >= 4) {
    return { session: parts.at(-3) ?? "unknown", agent: base.replace(/^agent-/, "") };
  }
  throw new Error(`unsupported transcript path ${file}`);
}

export interface HubReport {
  sessions: SessionUsage[];
  sessionCost: Record<string, SessionUsage>;
  days: DailyUsage[];
}

export type ArrivalOrder = "file" | "late";

/** Small deterministic PRNG so the "late" order is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * order "file": sorted path order, each session's statusLine (project_dir) first.
 * order "late": files shuffled and their chunks interleaved (subagent and main files mixed, as the
 * probe would ship them), project_dir statusLines only after every transcript line, with a history
 * read in between so the index is built before project_dir is known.
 */
export async function hubReport(opts: {
  dir: string;
  pricingFile: string;
  tz: string;
  order?: ArrivalOrder;
  /** Price every cache write at the 5-minute rate (ccusage behavior) to derive the 1-hour delta. */
  legacyCacheWrites?: boolean;
}): Promise<HubReport> {
  const order = opts.order ?? "file";
  const projects = path.join(opts.dir, "projects");
  const store = Store.open(":memory:");
  store.migrate();
  const config = loadConfig({
    HUB_TOKEN: TOKEN.padEnd(16, "x"),
    HUB_PRICING_FETCH: "0",
    HUB_HISTORY_BURST: "1000",
  });
  const loaded = loadPricing({ file: opts.pricingFile });
  const pricing = new PricingProvider(
    opts.legacyCacheWrites === true
      ? new PricingTable(loaded.models, loaded.source, false)
      : loaded,
  );
  const app = buildServer({ config, store, pricing });
  const auth = { authorization: `Bearer ${TOKEN.padEnd(16, "x")}` };
  await app.ready();
  try {
    let seq = 0;
    const sessionIds = new Set<string>();
    const projectOfSession = new Map<string, string>();
    const post = async (envelope: Record<string, unknown>): Promise<void> => {
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { ...auth, "content-type": "application/json" },
        payload: JSON.stringify({ host: "compare-host", envelopes: [envelope] }),
      });
      if (res.statusCode !== 200) throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
    };
    const base = () => ({
      v: 1,
      id: ulid(seq + 1),
      host: "compare-host",
      os: "linux",
      ts: 1_760_000_000_000 + seq * 6000,
      seq: seq++,
    });
    const statusLine = (session: string) => {
      // The project dir ccusage reads from the path ("-synthetic-proj-a") is the encoded cwd; a
      // statusLine tick gives the hub the same project_dir so its file order matches.
      const projectDir = projectOfSession.get(session)!;
      return post({
        ...base(),
        kind: "statusline",
        session_id: session,
        payload: { session_id: session, cwd: projectDir, workspace: { project_dir: projectDir } },
      });
    };
    const chunksOf = (file: string) => {
      const { session, agent } = locate(projects, file);
      const lines = readFileSync(file, "utf8").split("\n");
      const out: Record<string, unknown>[] = [];
      for (let start = 0; start < lines.length; start += 400)
        out.push({
          kind: "transcript",
          session_id: session,
          ...(agent !== "" ? { agent_id: agent } : {}),
          payload: { start_line: start, lines: lines.slice(start, start + 400) },
        });
      return out;
    };
    const files = walk(projects).sort();
    for (const file of files) {
      const { session } = locate(projects, file);
      sessionIds.add(session);
      if (!projectOfSession.has(session))
        projectOfSession.set(
          session,
          path.relative(projects, file).split(path.sep)[0]!.replace(/-/g, "/"),
        );
    }
    if (order === "file") {
      const done = new Set<string>();
      for (const file of files) {
        const { session } = locate(projects, file);
        if (!done.has(session)) {
          done.add(session);
          await statusLine(session);
        }
        for (const c of chunksOf(file)) await post({ ...base(), ...c });
      }
    } else {
      const rnd = mulberry32(20260101);
      const queues = files.map(chunksOf);
      // Fisher-Yates over the queues, then round-robin one chunk at a time.
      for (let i = queues.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [queues[i], queues[j]] = [queues[j]!, queues[i]!];
      }
      let left = true;
      while (left) {
        left = false;
        for (const q of queues) {
          const c = q.shift();
          if (c === undefined) continue;
          left = true;
          await post({ ...base(), ...c });
        }
      }
      // Build the index while project_dir is still unknown, then learn it.
      await app.inject({ method: "GET", url: "/history/daily?tz=UTC", headers: auth });
      for (const session of [...sessionIds].sort(() => rnd() - 0.5)) await statusLine(session);
    }
    const get = async <T>(url: string): Promise<T> => {
      const r = await app.inject({ method: "GET", url, headers: auth });
      if (r.statusCode !== 200) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
      return r.json() as T;
    };
    const tz = encodeURIComponent(opts.tz);
    const sessions = (await get<{ sessions: SessionUsage[] }>(`/history/sessions?tz=${tz}`))
      .sessions;
    const days = (await get<{ days: DailyUsage[] }>(`/history/daily?tz=${tz}`)).days;
    const sessionCost: Record<string, SessionUsage> = {};
    for (const id of sessionIds) {
      sessionCost[id] = await get<SessionUsage>(
        `/sessions/${encodeURIComponent(id)}/cost?tz=${tz}`,
      );
    }
    return { sessions, sessionCost, days };
  } finally {
    await app.close();
    store.close();
  }
}

const TIER = 200_000;
const tierCost = (n: number, base: number | undefined, above: number | undefined): number =>
  n <= 0 || base == null
    ? 0
    : n > TIER && above != null
      ? TIER * base + (n - TIER) * above
      : n * base;

export interface IndependentDelta {
  bySession: Record<string, number>;
  byDay: Record<string, number>;
  total: number;
}

/**
 * The expected hub-minus-ccusage cost (sum of 1-hour write tokens x (1-hour rate - 5-minute rate)),
 * computed straight from the transcript files and the pricing file, without the hub's cost formula.
 * Dedup follows usage.ts (id:requestId; more tokens wins, then speed present, then smaller file key
 * and line) but is written out here; rows with costUSD or an unpriced model have no delta.
 */
export function independentDelta(opts: {
  dir: string;
  pricingFile: string;
  tz: string;
}): IndependentDelta {
  const projects = path.join(opts.dir, "projects");
  const table = new PricingTable(loadPricing({ file: opts.pricingFile }).models, "file");
  const dayOf = makeDayFormatter(opts.tz);
  interface Best {
    session: string;
    key: string;
    line: number;
    total: number;
    fast: boolean;
    delta: number;
    ts: string;
  }
  const best = new Map<string, Best>();
  const rows: Best[] = [];
  for (const file of walk(projects).sort()) {
    const { session } = locate(projects, file);
    const key = path.relative(projects, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((raw, line) => {
        const d = parseUsageLine(raw);
        if (d === null) return;
        const u = d.message.usage;
        const cc = u.cache_creation_input_tokens ?? 0;
        const h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        const total = u.input_tokens + u.output_tokens + cc + (u.cache_read_input_tokens ?? 0);
        let delta = 0;
        const p: ModelPricing | null =
          d.costUSD === undefined && d.message.model ? table.lookup(d.message.model) : null;
        if (p !== null && h > 0 && cc > 0) {
          const r5 = (n: number) =>
            tierCost(
              n,
              p.cache_creation_input_token_cost,
              p.cache_creation_input_token_cost_above_200k_tokens,
            );
          const r1 = (n: number) =>
            tierCost(
              n,
              p.cache_creation_input_token_cost_above_1hr ??
                (p.input_cost_per_token == null ? undefined : 2 * p.input_cost_per_token),
              p.cache_creation_input_token_cost_above_1hr_above_200k_tokens ??
                (p.input_cost_per_token_above_200k_tokens == null
                  ? undefined
                  : 2 * p.input_cost_per_token_above_200k_tokens),
            );
          const all = Math.max(cc, h + (u.cache_creation?.ephemeral_5m_input_tokens ?? 0));
          const fast = u.speed === "fast" ? (p.provider_specific_entry?.fast ?? 1) : 1;
          // Average per-token rate gap over the whole write, times the 1-hour tokens.
          delta = h * ((r1(all) - r5(all)) / all) * fast;
        }
        const row: Best = {
          session,
          key,
          line,
          total,
          fast: u.speed != null,
          delta,
          ts: d.timestamp,
        };
        const hash = createUniqueHash(d);
        if (hash === null) return void rows.push(row);
        const ex = best.get(hash);
        if (ex !== undefined) {
          const better =
            row.total !== ex.total
              ? row.total > ex.total
              : row.fast !== ex.fast
                ? row.fast
                : row.key < ex.key || (row.key === ex.key && row.line < ex.line);
          if (!better) return;
          rows.splice(rows.indexOf(ex), 1);
        }
        best.set(hash, row);
        rows.push(row);
      });
  }
  const out: IndependentDelta = { bySession: {}, byDay: {}, total: 0 };
  for (const r of rows) {
    out.bySession[r.session] = (out.bySession[r.session] ?? 0) + r.delta;
    const day = dayOf(r.ts);
    out.byDay[day] = (out.byDay[day] ?? 0) + r.delta;
    out.total += r.delta;
  }
  return out;
}
