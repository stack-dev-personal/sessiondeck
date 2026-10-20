// Hub half of the ccusage comparison (bundled and imported by ccusage-compare.mjs). Loads a
// CLAUDE_CONFIG_DIR-style tree into an in-memory hub through the real POST /ingest path, then
// reads the cost history back over REST with a bearer token.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { PricingProvider, loadPricing } from "../src/pricing/loader.ts";
import { buildServer } from "../src/server.ts";
import type { DailyUsage, SessionUsage } from "../src/usage/usage.ts";

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

export async function hubReport(opts: {
  dir: string;
  pricingFile: string;
  tz: string;
}): Promise<HubReport> {
  const projects = path.join(opts.dir, "projects");
  const store = Store.open(":memory:");
  store.migrate();
  const config = loadConfig({ HUB_TOKEN: TOKEN.padEnd(16, "x"), HUB_PRICING_FETCH: "0" });
  const pricing = new PricingProvider(loadPricing({ file: opts.pricingFile }));
  const app = buildServer({ config, store, pricing });
  const auth = { authorization: `Bearer ${TOKEN.padEnd(16, "x")}` };
  await app.ready();
  try {
    let seq = 0;
    const sessionIds = new Set<string>();
    for (const file of walk(projects).sort()) {
      const { session, agent } = locate(projects, file);
      sessionIds.add(session);
      const lines = readFileSync(file, "utf8").split("\n");
      for (let start = 0; start < lines.length; start += 400) {
        const chunk = lines.slice(start, start + 400);
        const res = await app.inject({
          method: "POST",
          url: "/ingest",
          headers: { ...auth, "content-type": "application/json" },
          payload: JSON.stringify({
            host: "compare-host",
            envelopes: [
              {
                v: 1,
                id: ulid(seq + 1),
                kind: "transcript",
                host: "compare-host",
                os: "linux",
                session_id: session,
                ...(agent !== "" ? { agent_id: agent } : {}),
                ts: 1_760_000_000_000 + seq * 6000,
                seq: seq++,
                payload: { start_line: start, lines: chunk },
              },
            ],
          }),
        });
        if (res.statusCode !== 200) throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
      }
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
