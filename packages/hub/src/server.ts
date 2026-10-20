import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { HubConfig } from "./config.ts";
import type { Store } from "./db/store.ts";
import { Ingestor, type HubEmitter } from "./ingest/ingestor.ts";
import { registerIngest } from "./ingest/route.ts";
import { RateLimiter } from "./ingest/rate-limit.ts";
import { registerRead } from "./routes/read.ts";
import { registerStream, tokenFromProtocols } from "./stream.ts";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function buildServer(opts: {
  config: HubConfig;
  store: Store;
  logger?: boolean;
  /** Test hook: destination for log lines (implies logging). */
  logStream?: { write(msg: string): void };
  /** Test hook: clock for the rate limiter and the hosts.last_seen column. */
  now?: () => number;
  /** Test hooks for WS /stream. */
  heartbeatMs?: number;
  maxBufferedBytes?: number;
  refuseFallbackMs?: number;
}): FastifyInstance {
  const expected = digest(opts.config.token);

  const isAuthed = (header: string | string[] | undefined): boolean => {
    const m = typeof header === "string" ? header.match(/^bearer (.+)$/i) : null;
    return m?.[1] !== undefined && timingSafeEqual(digest(m[1]), expected);
  };
  /** Digest (hex) of the credential that authenticated, else null; the limiter key (trusted value). */
  const principalOf = (header: string | string[] | undefined): string | null => {
    const m = typeof header === "string" ? header.match(/^bearer (.+)$/i) : null;
    return m?.[1] !== undefined && timingSafeEqual(digest(m[1]), expected)
      ? digest(m[1]).toString("hex")
      : null;
  };
  const principalOfToken = (t: string | null): string | null =>
    t !== null && timingSafeEqual(digest(t), expected) ? digest(t).toString("hex") : null;
  const deny = (reply: FastifyReply) => reply.code(401).header("content-length", "0").send();

  const logging = opts.logger === true || opts.logStream !== undefined;
  const app = Fastify({
    logger: logging
      ? {
          level: "info",
          redact: ["req.headers.authorization"],
          ...(opts.logStream ? { stream: opts.logStream } : {}),
          serializers: {
            // Never log the query string verbatim (could carry a token).
            req(req: { method?: string; url?: string; hostname?: string }) {
              return {
                method: req.method,
                url: (req.url ?? "").split("?")[0],
                hostname: req.hostname,
              };
            },
          },
        }
      : false,
    // Malformed URLs fail before onRequest; keep the empty-401 rule and avoid fingerprinting.
    frameworkErrors: (_err, req, res) => {
      const reply = res as unknown as FastifyReply;
      if (!isAuthed(req.headers.authorization)) return deny(reply);
      return reply.code(400).header("content-length", "0").send();
    },
  });

  // Sanitize thrown errors only; replies a route sends itself (e.g. 4xx with a reason) bypass this.
  const sanitize = (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status =
      typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;
    req.log.error({ code: err.code, status, reqId: req.id }, "request error");
    return reply.code(status).send({ error: status === 500 ? "internal" : "bad_request" });
  };
  app.setErrorHandler(sanitize);

  app.decorate("store", opts.store);

  // D-S3-14: reads and upgrades share one per-principal bucket, separate from ingest's.
  const now = opts.now ?? Date.now;
  const readLimiter = new RateLimiter(opts.config.readRate, opts.config.readBurst, 16, now);
  app.addHook("onRequest", async (req, reply) => {
    if ((req.method === "GET" || req.method === "HEAD") && req.url.split("?")[0] === "/health")
      return;
    const principal = principalOf(req.headers.authorization);
    if (principal === null) return deny(reply);
    if ((req.method === "GET" || req.method === "HEAD") && !readLimiter.take(principal, 1)) {
      return reply.code(429).header("content-length", "0").send();
    }
  });

  // The default 404 handler logs "Route GET:<url with query> not found"; reply without it.
  app.setNotFoundHandler((_req, reply) => reply.code(404).header("content-length", "0").send());

  app.get("/health", async () => ({ ok: true }));

  const ingestor = new Ingestor(opts.store, app.log, now, {
    maxOpenSessionsPerHost: opts.config.maxOpenSessionsPerHost,
  });
  app.decorate("hub", {
    events: ingestor.events,
    reducerExceptionCount: () => ingestor.reducerExceptionCount(),
  });
  registerIngest(app, {
    ingestor,
    store: opts.store,
    // One token in the MVP; the key space is the set of valid principals, so a small cap.
    principalLimiter: new RateLimiter(opts.config.ingestRate, opts.config.ingestBurst, 16, now),
    hostLimiter: new RateLimiter(
      opts.config.hostRate,
      opts.config.hostBurst,
      opts.config.maxHosts * 2,
      now,
    ),
    maxHosts: opts.config.maxHosts,
    sanitize,
  });
  registerRead(app, opts.store, now);
  registerStream(app, {
    store: opts.store,
    events: ingestor.events,
    now,
    // Upgrade requests never pass through onRequest: header bearer, or the browser subprotocol.
    // The limiter key is the digest of whichever credential actually authenticated.
    authenticate: (req) =>
      principalOf(req.headers.authorization) ??
      principalOfToken(tokenFromProtocols(req.headers["sec-websocket-protocol"])),
    allowRead: (principal) => readLimiter.take(principal, 1),
    maxClients: opts.config.maxWsClients,
    allowedOrigins: opts.config.allowedOrigins,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.refuseFallbackMs !== undefined ? { refuseFallbackMs: opts.refuseFallbackMs } : {}),
    ...(opts.maxBufferedBytes !== undefined ? { maxBufferedBytes: opts.maxBufferedBytes } : {}),
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    hub: {
      /** Emits `batch` once per committed ingest batch (never for rejected or rolled-back ones). */
      events: HubEmitter;
      reducerExceptionCount(): number;
    };
  }
}
