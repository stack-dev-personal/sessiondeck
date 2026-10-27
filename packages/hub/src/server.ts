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
import { registerAtlas } from "./routes/atlas.ts";
import { registerSearch } from "./routes/search.ts";
import { registerCost } from "./routes/cost.ts";
import { registerLayouts } from "./routes/layouts.ts";
import { registerRead } from "./routes/read.ts";
import { PricingProvider, bundledTable } from "./pricing/loader.ts";
import { IngestActivity } from "./ingest/activity.ts";
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
  /** Test hook: wall clock for the envelope-ts bound (defaults to Date.now, independent of `now`). */
  wallClock?: () => number;
  /** Test hooks for WS /stream. */
  heartbeatMs?: number;
  maxBufferedBytes?: number;
  refuseFallbackMs?: number;
  /** Cost history pricing; defaults to the bundled table. main.ts passes the configured one. */
  pricing?: PricingProvider;
  /** Shared with background work that yields to ingest (retention); created here when absent. */
  activity?: IngestActivity;
}): FastifyInstance {
  const activity = opts.activity ?? new IngestActivity();
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
  const historyLimiter = new RateLimiter(
    opts.config.historyRate,
    opts.config.historyBurst,
    16,
    now,
  );
  // CORS for the web app's REST calls when it is served from another origin. Driven by
  // HUB_ALLOWED_ORIGINS (exact match, never "*"). Unlike the WS check, an empty list means no CORS
  // headers at all (same-origin only), not "accept any". /ingest is never exposed to browsers.
  // Bearer header, not cookies: no Allow-Credentials.
  const corsOrigins = new Set(opts.config.allowedOrigins);
  const corsOriginOf = (req: FastifyRequest): string | null => {
    const o = req.headers.origin;
    if (typeof o !== "string" || !corsOrigins.has(o)) return null;
    if (req.url.split("?")[0] === "/ingest") return null;
    return o;
  };
  const preflightLimiter = new RateLimiter(opts.config.readRate, opts.config.readBurst, 1024, now);
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "OPTIONS" || req.headers["access-control-request-method"] === undefined)
      return;
    const origin = corsOriginOf(req);
    if (origin === null) return; // falls through to the bearer hook: 401, no CORS headers
    if (!preflightLimiter.take(req.ip, 1)) {
      return reply.code(429).header("content-length", "0").send();
    }
    return reply
      .code(204)
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-methods", "GET, PATCH")
      .header("access-control-allow-headers", "authorization, content-type")
      .header("access-control-max-age", "600")
      .send();
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("vary", "Origin");
    const origin = corsOriginOf(req);
    if (origin !== null) reply.header("access-control-allow-origin", origin);
    return payload;
  });
  // Layout writes only (ingest is unchanged): 2/s, burst 10 per principal.
  const writeLimiter = new RateLimiter(2, 10, 16, now);
  app.addHook("onRequest", async (req, reply) => {
    if ((req.method === "GET" || req.method === "HEAD") && req.url.split("?")[0] === "/health")
      return;
    const principal = principalOf(req.headers.authorization);
    if (principal === null) return deny(reply);
    // Only authenticated ingest counts as activity, or a tokenless client could keep compaction from
    // ever seeing quiet. Covers body read, handling and the reply: closed by the response's own
    // 'close', which also fires when the client aborts, so a dropped connection cannot leave the
    // counter raised.
    if (req.method === "POST" && req.url.split("?")[0] === "/ingest") {
      reply.raw.once("close", activity.begin());
    }
    // PATCH (atlas edits) shares the read bucket: no separate write bucket for a handful of routes.
    if (
      (req.method === "GET" || req.method === "HEAD" || req.method === "PATCH") &&
      !readLimiter.take(principal, 1)
    ) {
      return reply.code(429).header("content-length", "0").send();
    }
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      req.url.split("?")[0]?.startsWith("/history/") === true
    ) {
      if (!historyLimiter.take(principal, 1)) {
        return reply.code(429).header("content-length", "0").send();
      }
    }
  });

  // The default 404 handler logs "Route GET:<url with query> not found"; reply without it.
  app.setNotFoundHandler((_req, reply) => reply.code(404).header("content-length", "0").send());

  app.get("/health", async () => ({ ok: true }));

  opts.store.onSearchFlushError = (err) =>
    app.log.error(
      { err: err instanceof Error ? err.message : "error" },
      "search index flush failed",
    );
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
    now: opts.wallClock ?? Date.now,
    maxClockSkewMs: opts.config.maxClockSkewMs,
    sanitize,
  });
  registerRead(app, opts.store, now);
  registerLayouts(app, opts.store, now, (authorization) => {
    const p = principalOf(authorization);
    return p !== null && writeLimiter.take(p, 1);
  });
  const pricing = opts.pricing ?? new PricingProvider(bundledTable());
  const usage = registerCost(app, opts.store, pricing, opts.config.timezone);
  // Same global bearer hook as every other route: PATCH needs the ingest token.
  registerAtlas(
    app,
    opts.store,
    now,
    usage,
    pricing,
    opts.config.timezone,
    ingestor.events,
    app.log,
  );
  registerSearch(app, opts.store);
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
