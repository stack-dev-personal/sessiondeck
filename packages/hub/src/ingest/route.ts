// Route shape informed by NirDiamant/claude-watch src/server/routes/events.ts (MIT); no code copied.
import { IngestRequestSchema, type IngestResponse } from "@sessiondeck/contract";
import { createHash } from "node:crypto";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../db/store.ts";
import type { Ingestor } from "./ingestor.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { MAX_ENVELOPES, checkBounds, reasonFromZod } from "./validate.ts";

/** Batches up to 1 MiB are accepted (R2.1). */
export const INGEST_BODY_LIMIT = 1024 * 1024;

const JSON_ERRORS = new Set(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]);

const tooMany = (reply: FastifyReply) => reply.code(429).header("content-length", "0").send();

/** Digest of the bearer token itself (not the header), so scheme-case variants share one bucket. */
const principalOf = (req: FastifyRequest): string =>
  createHash("sha256")
    .update(req.headers.authorization?.match(/^bearer (.+)$/i)?.[1] ?? "")
    .digest("hex");

function bad(reply: FastifyReply, reason: string) {
  return reply.code(400).send({ error: "invalid_envelope", reason });
}

export function registerIngest(
  app: FastifyInstance,
  deps: {
    ingestor: Ingestor;
    store: Store;
    /** D-S3-5 layer (a): keyed on the authenticated principal. */
    principalLimiter: RateLimiter;
    /** D-S3-5 layer (b): fairness per validated body.host. */
    hostLimiter: RateLimiter;
    /** D-S3-5 (c): new hosts are refused once the hosts table holds this many. */
    maxHosts: number;
    /** Hub clock and the allowed lead of an envelope ts over it (HUB_MAX_CLOCK_SKEW_MS). */
    now: () => number;
    maxClockSkewMs: number;
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
      const rawEnvelopes = rec["envelopes"];
      const cost = Array.isArray(rawEnvelopes) ? rawEnvelopes.length : 1;
      if (cost > MAX_ENVELOPES) return bad(reply, "too_many_envelopes");

      // (a) The bearer was verified by the onRequest hook; the key is its digest, never the token.
      if (!deps.principalLimiter.take(principalOf(req), cost)) return tooMany(reply);

      const parsed = IngestRequestSchema.safeParse(body);
      if (!parsed.success) return bad(reply, reasonFromZod(parsed.error));
      const { host, envelopes } = parsed.data;
      const boundsReason = checkBounds(host, envelopes);
      if (boundsReason !== null) return bad(reply, boundsReason);
      if (envelopes.some((e) => e.host !== host)) return bad(reply, "host_mismatch");
      // The contract bounds ts only below; a far-future ts would pin compaction and sample
      // pruning behind it. The batch is refused whole, like any other bound violation.
      const latest = deps.now() + deps.maxClockSkewMs;
      const future = envelopes.findIndex((e) => e.ts > latest);
      if (future >= 0) {
        // Counts only: no payload, no ids, no timestamps echoed from the batch.
        req.log.warn(
          { host: host.slice(0, 64), index: future, count: envelopes.length },
          "batch rejected: envelope ts too far in the future",
        );
        return bad(reply, `envelopes[${future}].ts: too_far_in_future`);
      }

      // (c) Synchronous from here to ingest(): the count and the insert cannot interleave.
      if (deps.store.getHost(host) === undefined && deps.store.countHosts() >= deps.maxHosts) {
        req.log.warn({ host_len: host.length, max_hosts: deps.maxHosts }, "host limit reached");
        return tooMany(reply);
      }
      // (b) Only validated hosts that fit under the cap reach a per-host bucket.
      if (!deps.hostLimiter.take(host, cost)) return tooMany(reply);

      const r = deps.ingestor.ingest(host, envelopes);
      // last_seq is the batch's acknowledged max (see Ingestor.ingest), never a stored max.
      // expired (older than the compaction watermark, acknowledged but not stored) is additive.
      const res: IngestResponse & { expired?: number; rejected?: number } = {
        accepted: r.accepted,
        last_seq: r.last_seq,
        ...(r.expired > 0 ? { expired: r.expired } : {}),
        ...(r.rejected > 0 ? { rejected: r.rejected } : {}),
      };
      return reply.send(res);
    },
  );
}
