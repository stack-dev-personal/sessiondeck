// R5.4. GET /search: command-palette search over sessions, projects and phases. Auth and the read
// rate limit come from the global onRequest hook in server.ts (every route but /health).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MAX_QUERY_CHARS } from "../atlas/search.ts";
import type { Store } from "../db/store.ts";

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

const Query = z
  .object({
    q: z.string().max(MAX_QUERY_CHARS).default(""),
    limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
  })
  .strict();

export function registerSearch(app: FastifyInstance, store: Store): void {
  app.get("/search", async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query" });
    }
    const t0 = performance.now();
    const results = store.search(parsed.data.q, parsed.data.limit);
    return { results, took_ms: Math.round((performance.now() - t0) * 100) / 100 };
  });
}
