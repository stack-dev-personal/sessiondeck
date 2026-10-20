import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.ts";
import type { PricingProvider } from "../pricing/loader.ts";
import { UsageCollector, emptyUsage, isValidTimeZone } from "../usage/usage.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const tz = z.string().max(64).refine(isValidTimeZone, "unknown time zone");
const HistoryQuery = z.object({ from: day.optional(), to: day.optional(), tz: tz.optional() });
const CostQuery = z.object({ tz: tz.optional() });

function badQuery(reply: FastifyReply, err: z.ZodError) {
  return reply
    .code(400)
    .send({ error: "invalid_query", reason: err.issues.map((i) => i.path.join(".")).join(",") });
}

/**
 * R2.10. Cost history is computed on read from transcript_lines (nothing is added to the ingest
 * path). Live numbers elsewhere keep preferring statusLine; these are ccusage-equivalent history.
 */
export function registerCost(
  app: FastifyInstance,
  store: Store,
  pricing: PricingProvider,
  defaultTz: string | undefined,
): void {
  // One session, dedup scoped to that session (ccusage dedups across all files; a message copied
  // into a resumed session is therefore counted here too, and once in /history/*).
  app.get<{ Params: { id: string } }>("/sessions/:id/cost", async (req, reply) => {
    const q = CostQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    const c = new UsageCollector(pricing.current(), q.data.tz ?? defaultTz, "session");
    for (const row of store.iterateSessionUsageLines(req.params.id)) c.addRow(row);
    const found = c.sessions()[0];
    if (found === undefined) {
      if (store.getSession(req.params.id) === undefined) {
        return reply.code(404).header("content-length", "0").send();
      }
      return {
        session_id: req.params.id,
        ...emptyUsage(),
        last_activity: null,
        versions: [],
      };
    }
    return found;
  });

  // Global dedup, like `ccusage session`. Sorted by cost descending (ccusage default order).
  app.get("/history/sessions", async (req, reply) => {
    const q = HistoryQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    const c = collectAll(store, pricing, q.data.tz ?? defaultTz);
    const sessions = c
      .sessions()
      .filter(
        (s) =>
          (q.data.from === undefined || s.last_activity >= q.data.from) &&
          (q.data.to === undefined || s.last_activity <= q.data.to),
      )
      .sort((a, b) => b.cost_usd - a.cost_usd);
    return { sessions };
  });

  // Global dedup, like `ccusage daily`. Days ascending; from/to inclusive, in the response tz.
  app.get("/history/daily", async (req, reply) => {
    const q = HistoryQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    const zone = q.data.tz ?? defaultTz;
    const c = collectAll(store, pricing, zone);
    return {
      tz: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      days: c.daily(q.data.from, q.data.to),
    };
  });
}

function collectAll(store: Store, pricing: PricingProvider, zone: string | undefined) {
  const c = new UsageCollector(pricing.current(), zone, "global");
  for (const row of store.iterateAllUsageLines()) c.addRow(row);
  return c;
}
