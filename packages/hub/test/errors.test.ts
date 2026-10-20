import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { tempStore } from "./helpers.ts";

const TOKEN = "t".repeat(24);
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let cleanup: () => void;
const logs: string[] = [];

beforeEach(async () => {
  logs.length = 0;
  const t = tempStore();
  cleanup = t.cleanup;
  t.store.migrate();
  app = buildServer({
    config: loadConfig({ HUB_TOKEN: TOKEN }),
    store: t.store,
    logStream: { write: (m) => void logs.push(m) },
  });
  app.post("/t/json", async () => ({ ok: true }));
  app.get("/t/throw", async () => {
    throw new Error("no such column secret_col");
  });
  app.get("/t/reason", async (_req, reply) => reply.code(400).send({ reason: "bad field x" }));
  await app.ready();
});
afterEach(async () => {
  await app.close();
  cleanup();
});

describe("error handler", () => {
  it("malformed JSON returns no FST_ code and no input echo", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/t/json",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not-json-ECHOME",
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/FST_|ECHOME|JSON/);
  });

  it("thrown Error returns 500 without the message", async () => {
    const r = await app.inject({ method: "GET", url: "/t/throw", headers: auth });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("secret_col");
    expect(r.json()).toEqual({ error: "internal" });
    expect(logs.join("")).not.toContain("secret_col");
  });

  it("route-produced 4xx replies are left alone", async () => {
    const r = await app.inject({ method: "GET", url: "/t/reason", headers: auth });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ reason: "bad field x" });
  });
});
