import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.ts";
import type { PricingProvider } from "../pricing/loader.ts";
import { UsageService } from "../usage/service.ts";
import { emptyUsage, isValidTimeZone } from "../usage/usage.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const tz = z.string().max(64).refine(isValidTimeZone, "unknown time zone");
const HistoryQuery = z.object({ from: day.optional(), to: day.optional(), tz: tz.optional() });
const SessionsQuery = HistoryQuery.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const CostQuery = z.object({ tz: tz.optional() });

function badQuery(reply: FastifyReply, err: z.ZodError) {
  return reply
    .code(400)
    .send({ error: "invalid_query", reason: err.issues.map((i) => i.path.join(".")).join(",") });
}

/**
 * R2.10. Cost history comes from an in-memory index of the parsed usage lines in transcript_lines
 * (UsageService; rebuilt from the DB, advanced by rowid), aggregated on read. Nothing is added to
 * the ingest path. Live numbers elsewhere keep preferring statusLine; these are ccusage-equivalent
 * history. Dedup is global in every endpoint, like ccusage.
 */
export function registerCost(
  app: FastifyInstance,
  store: Store,
  pricing: PricingProvider,
  defaultTz: string | undefined,
): UsageService {
  const usage = new UsageService(store, app.log);
  app.addHook("onReady", async () => {
    // Warm the index in the background; failures surface again on the first request.
    void usage.refresh().catch((err: unknown) => {
      app.log.error(
        { err: err instanceof Error ? err.name : "unknown" },
        "usage index warm-up failed",
      );
    });
  });
  app.addHook("onClose", async () => usage.close());

  app.get<{ Params: { id: string } }>("/sessions/:id/cost", async (req, reply) => {
    const q = CostQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    await usage.refresh();
    const zone = q.data.tz ?? defaultTz;
    const table = pricing.current();
    const found = usage.memo(
      `s|${zone ?? ""}|${req.params.id}`,
      table,
      () => usage.index.sessions(table, zone, req.params.id)[0],
    );
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

  // Like `ccusage session`: cost descending, newest-activity day filtered by from/to, capped.
  app.get("/history/sessions", async (req, reply) => {
    const q = SessionsQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    await usage.refresh();
    const { from, to, limit } = q.data;
    const zone = q.data.tz ?? defaultTz;
    const table = pricing.current();
    return usage.memo(`hs|${zone ?? ""}|${from ?? ""}|${to ?? ""}|${limit}`, table, () => ({
      sessions: usage.index
        .sessions(table, zone)
        .filter(
          (s) =>
            (from === undefined || s.last_activity >= from) &&
            (to === undefined || s.last_activity <= to),
        )
        .sort((a, b) => b.cost_usd - a.cost_usd)
        .slice(0, limit),
    }));
  });

  // Like `ccusage daily`. Days ascending; from/to inclusive, in the response tz.
  app.get("/history/daily", async (req, reply) => {
    const q = HistoryQuery.safeParse(req.query);
    if (!q.success) return badQuery(reply, q.error);
    await usage.refresh();
    const zone = q.data.tz ?? defaultTz;
    const table = pricing.current();
    return usage.memo(`hd|${zone ?? ""}|${q.data.from ?? ""}|${q.data.to ?? ""}`, table, () => ({
      tz: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      days: usage.index.daily(table, zone, q.data.from, q.data.to),
    }));
  });
  return usage;
}
