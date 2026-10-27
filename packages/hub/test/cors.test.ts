import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { tempStore } from "./helpers.ts";

const TOKEN = "t".repeat(24);
const OK = "http://localhost:5173";
const BAD = "http://evil.example";
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let cleanup: () => void;

async function boot(origins: string): Promise<void> {
  const t = tempStore();
  cleanup = t.cleanup;
  t.store.migrate();
  const env: Record<string, string> = { HUB_TOKEN: TOKEN };
  if (origins) env["HUB_ALLOWED_ORIGINS"] = origins;
  app = buildServer({ config: loadConfig(env), store: t.store });
  await app.ready();
}
afterEach(async () => {
  await app.close();
  cleanup();
});
const pre = (origin: string, url = "/projects") =>
  app.inject({
    method: "OPTIONS",
    url,
    headers: {
      origin,
      "access-control-request-method": "PATCH",
      "access-control-request-headers": "authorization,content-type",
    },
  });

describe("hub CORS", () => {
  it("allowed origin: ACAO on GET, PATCH and preflight", async () => {
    await boot(`${OK},http://127.0.0.1:5173`);
    const g = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { ...auth, origin: OK },
    });
    expect(g.statusCode).toBe(200);
    expect(g.headers["access-control-allow-origin"]).toBe(OK);
    expect(g.headers["vary"]).toContain("Origin");
    expect(g.headers["access-control-allow-credentials"]).toBeUndefined();
    const p = await app.inject({
      method: "PATCH",
      url: "/sessions/nope/phase",
      headers: { ...auth, origin: OK, "content-type": "application/json" },
      payload: { phase: "x" },
    });
    expect(p.headers["access-control-allow-origin"]).toBe(OK);
    const o = await pre(OK);
    expect(o.statusCode).toBe(204);
    expect(o.headers["access-control-allow-origin"]).toBe(OK);
    expect(o.headers["access-control-allow-methods"]).toBe("GET, PATCH");
    expect(o.headers["access-control-allow-headers"]).toBe("authorization, content-type");
    expect(o.headers["access-control-max-age"]).toBe("600");
    expect(o.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(o.headers["vary"]).toContain("Origin");
    expect(o.body).toBe("");
  });

  it("disallowed origin: no CORS headers, preflight not granted", async () => {
    await boot(OK);
    const g = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { ...auth, origin: BAD },
    });
    expect(g.headers["access-control-allow-origin"]).toBeUndefined();
    expect(g.headers["vary"]).toContain("Origin");
    const o = await pre(BAD);
    expect(o.statusCode).not.toBe(204);
    expect(o.headers["access-control-allow-origin"]).toBeUndefined();
    expect(o.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("empty list: no CORS headers at all", async () => {
    await boot("");
    const g = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { ...auth, origin: OK },
    });
    expect(g.headers["access-control-allow-origin"]).toBeUndefined();
    const o = await pre(OK);
    expect(o.statusCode).not.toBe(204);
    expect(o.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("/ingest never gets CORS headers, preflight included", async () => {
    await boot(OK);
    const o = await pre(OK, "/ingest");
    expect(o.statusCode).not.toBe(204);
    expect(o.headers["access-control-allow-origin"]).toBeUndefined();
    const p = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { ...auth, origin: OK, "content-type": "application/json" },
      payload: "{}",
    });
    expect(p.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preflight needs no auth, the actual request still 401s without a token", async () => {
    await boot(OK);
    expect((await pre(OK)).statusCode).toBe(204);
    const r = await app.inject({ method: "GET", url: "/projects", headers: { origin: OK } });
    expect(r.statusCode).toBe(401);
    expect(r.body).toBe("");
  });

  it("plain OPTIONS without a request-method header is not a preflight", async () => {
    await boot(OK);
    const r = await app.inject({ method: "OPTIONS", url: "/projects", headers: { origin: OK } });
    expect(r.statusCode).toBe(401);
  });

  it("preflights are rate limited", async () => {
    await boot(OK);
    const codes = new Set<number>();
    for (let i = 0; i < 400; i++) codes.add((await pre(OK)).statusCode);
    expect(codes.has(429)).toBe(true);
  });
});
