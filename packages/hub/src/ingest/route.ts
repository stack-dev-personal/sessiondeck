// Route shape informed by NirDiamant/claude-watch src/server/routes/events.ts (MIT); no code copied.
import { IngestRequestSchema, type IngestResponse } from "@sessiondeck/contract";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ingestor } from "./ingestor.ts";
import type { HostRateLimiter } from "./rate-limit.ts";
import { reasonFromZod } from "./validate.ts";

/** Batches up to 1 MiB are accepted (R2.1). */
export const INGEST_BODY_LIMIT = 1024 * 1024;

const JSON_ERRORS = new Set(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]);

function bad(reply: FastifyReply, reason: string) {
  return reply.code(400).send({ error: "invalid_envelope", reason });
}

export function registerIngest(
  app: FastifyInstance,
  deps: {
    ingestor: Ingestor;
    limiter: HostRateLimiter;
    sanitize: (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => unknown;
  },
): void {
  app.post(
    "/ingest",
    {
      bodyLimit: INGEST_BODY_LIMIT,
      errorHandler: (err, req, reply) => {
        if (err.code !== undefined && JSON_ERRORS.has(err.code)) return bad(reply, "invalid_json");
        if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.code(413).send({ error: "payload_too_large" });
        }
        return deps.sanitize(err, req, reply);
      },
    },
    async (req, reply) => {
      const body: unknown = req.body;
      const rec =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const hostKey = typeof rec["host"] === "string" ? rec["host"] : "";
      const cost = Array.isArray(rec["envelopes"]) ? rec["envelopes"].length : 1;
      if (!deps.limiter.take(hostKey, cost)) {
        return reply.code(429).header("content-length", "0").send();
      }

      const parsed = IngestRequestSchema.safeParse(body);
      if (!parsed.success) return bad(reply, reasonFromZod(parsed.error));
      const { host, envelopes } = parsed.data;
      if (envelopes.some((e) => e.host !== host)) return bad(reply, "host_mismatch");

      const r = deps.ingestor.ingest(host, envelopes);
      const res: IngestResponse = { accepted: r.accepted, last_seq: r.last_seq };
      return reply.send(res);
    },
  );
}
