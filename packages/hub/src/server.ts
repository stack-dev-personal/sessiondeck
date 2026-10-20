import Fastify, { type FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { HubConfig } from "./config.ts";
import type { Store } from "./db/store.ts";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function buildServer(opts: {
  config: HubConfig;
  store: Store;
  logger?: boolean;
}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? { level: "info", redact: ["req.headers.authorization"] } : false,
  });
  const expected = digest(opts.config.token);

  app.decorate("store", opts.store);

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url.split("?")[0] === "/health") return;
    const header = req.headers.authorization;
    const m = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
    const ok = m?.[1] !== undefined && timingSafeEqual(digest(m[1]), expected);
    if (!ok) return reply.code(401).header("content-length", "0").send();
  });

  app.get("/health", async () => ({ ok: true }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
  }
}
