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
