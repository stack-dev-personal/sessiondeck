import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { tempStore } from "./helpers.ts";

const TOKEN = "t".repeat(24);
let app: FastifyInstance;
let cleanup: () => void;

beforeEach(async () => {
  const t = tempStore();
  cleanup = t.cleanup;
  t.store.migrate();
  app = buildServer({ config: loadConfig({ HUB_TOKEN: TOKEN }), store: t.store });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  cleanup();
});

describe("bearer auth", () => {
  it("serves /health without a token", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it.each([
    ["no header", undefined],
    ["wrong token", "Bearer nope"],
    ["empty bearer", "Bearer"],
    ["empty bearer with space", "Bearer "],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["token without scheme", TOKEN],
  ])("401 with empty body: %s", async (_n, auth) => {
    for (const url of ["/sessions", "/does/not/exist"]) {
      const r = await app.inject({
        method: "GET",
        url,
        headers: auth === undefined ? {} : { authorization: auth },
      });
      expect(r.statusCode).toBe(401);
      expect(r.body).toBe("");
      expect(r.headers["www-authenticate"]).toBeUndefined();
    }
  });

  it("HEAD /health is exempt; HEAD elsewhere is 401", async () => {
    expect((await app.inject({ method: "HEAD", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/sessions" })).statusCode).toBe(401);
  });

  it("scheme is case-insensitive, token exact", async () => {
    for (const scheme of ["bearer", "BEARER", "Bearer"]) {
      const r = await app.inject({
        method: "GET",
        url: "/nothing",
        headers: { authorization: `${scheme} ${TOKEN}` },
      });
      expect(r.statusCode).toBe(404);
    }
    const bad = await app.inject({
      method: "GET",
      url: "/nothing",
      headers: { authorization: `bearer ${TOKEN.toUpperCase()}` },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("malformed URL without a token gets an empty 401, no framework detail", async () => {
    for (const url of ["/%zz", "/secret%zz"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(401);
      expect(r.body).toBe("");
    }
    const authed = await app.inject({
      method: "GET",
      url: "/%zz",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authed.statusCode).toBe(400);
    expect(authed.body).toBe("");
  });

  it("logs neither the Authorization value nor a ?token= value", async () => {
    const lines: string[] = [];
    const t = tempStore();
    t.store.migrate();
    const logged = buildServer({
      config: loadConfig({ HUB_TOKEN: TOKEN }),
      store: t.store,
      logStream: { write: (m) => void lines.push(m) },
    });
    await logged.ready();
    await logged.inject({
      method: "GET",
      url: "/nothing?token=QUERYSECRET123&x=1",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await logged.inject({ method: "GET", url: "/health?token=QUERYSECRET123" });
    await logged.close();
    t.cleanup();
    const all = lines.join("");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain("QUERYSECRET123");
    expect(all).not.toContain(TOKEN);
  });

  it("401 on POST /health and unauthenticated POST", async () => {
    expect((await app.inject({ method: "POST", url: "/health" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/ingest", payload: {} })).statusCode).toBe(
      401,
    );
  });

  it("correct token on an unknown route reaches 404", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/nothing",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.statusCode).toBe(404);
  });
});
