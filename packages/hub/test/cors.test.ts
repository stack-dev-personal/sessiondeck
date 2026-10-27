import { afterEach, describe, expect, it } from "vitest";
import { AUTH, makeHub, type TestHub } from "./support/hub.ts";

const ORIGIN = "http://localhost:5173";
const ENV = { HUB_ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:5173` };
let h: TestHub;
afterEach(async () => {
  await h.cleanup();
});

const body = {
  name: "L",
  hotkey: null,
  host: null,
  spec: { version: 1, root: { kind: "pane" } },
};
const pre = (
  url: string,
  method: string,
  origin: string | undefined = ORIGIN,
  headers = "authorization, content-type",
) =>
  h.app.inject({
    method: "OPTIONS",
    url,
    headers: {
      ...(origin ? { origin } : {}),
      "access-control-request-method": method,
      "access-control-request-headers": headers,
    },
  });

describe("R6.3 CORS, allowlist set", () => {
  it("answers an allowed preflight with 204 and exact headers, no auth", async () => {
    h = await makeHub(ENV);
    const r = await pre("/layouts/x", "PUT");
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(r.headers["vary"]).toBe("Origin");
    expect(r.headers["access-control-allow-methods"]).toBe("GET, HEAD, PUT, DELETE");
    expect(r.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
    expect(r.headers["access-control-max-age"]).toBe("600");
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(r.body).toBe("");
    expect((await pre("/layouts", "GET")).statusCode).toBe(204);
    expect((await pre("/sessions/abc/events", "GET")).statusCode).toBe(204);
  });

  it("refuses disallowed origins, methods, headers and paths without ACAO", async () => {
    h = await makeHub(ENV);
    const cases = [
      await pre("/layouts/x", "PUT", "http://evil.example"),
      await pre("/layouts/x", "PUT", "http://localhost:5173/"),
      await pre("/layouts/x", "POST"),
      await pre("/layouts/x", "PUT", ORIGIN, "x-custom"),
      await pre("/ingest", "POST"),
      await pre("/ingest", "PUT"),
      await pre("/stream", "GET"),
      await pre("/sessions", "DELETE"),
      await pre("/nope", "GET"),
    ];
    for (const r of cases) {
      expect(r.statusCode).toBe(403);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      expect(r.body).toBe("");
    }
  });

  it("decorates real GET/PUT/DELETE for an allowed origin only", async () => {
    h = await makeHub(ENV, () => 1_800_000_000_000);
    const hdr = { ...AUTH, origin: ORIGIN };
    const put = await h.app.inject({
      method: "PUT",
      url: "/layouts/x",
      headers: hdr,
      payload: body,
    });
    const get = await h.app.inject({ method: "GET", url: "/layouts", headers: hdr });
    const del = await h.app.inject({ method: "DELETE", url: "/layouts/x", headers: hdr });
    expect([put.statusCode, get.statusCode, del.statusCode]).toEqual([200, 200, 204]);
    for (const r of [put, get, del]) {
      expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(r.headers["vary"]).toBe("Origin");
      expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    const bad = await h.app.inject({
      method: "GET",
      url: "/layouts",
      headers: { ...AUTH, origin: "http://evil.example" },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const none = await h.app.inject({ method: "GET", url: "/layouts", headers: AUTH });
    expect(none.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not decorate /ingest, and a 401 stays empty", async () => {
    h = await makeHub(ENV);
    const r = await h.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { ...AUTH, origin: ORIGIN, "content-type": "application/json" },
      payload: "{}",
    });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const u = await h.app.inject({ method: "GET", url: "/layouts", headers: { origin: ORIGIN } });
    expect(u.statusCode).toBe(401);
    expect(u.body).toBe("");
  });

  it("treats percent-encoded paths like the plain path", async () => {
    h = await makeHub(ENV);
    expect((await pre("/%6Cayouts/x", "PUT")).statusCode).toBe(204);
    expect((await pre("/%69ngest", "PUT")).statusCode).toBe(403);
    // Malformed URLs fail in the framework before any hook: the existing empty 401, no ACAO.
    const mal = await pre("/%ZZ", "GET");
    expect(mal.statusCode).toBe(401);
    expect(mal.headers["access-control-allow-origin"]).toBeUndefined();
    const r = await h.app.inject({
      method: "GET",
      url: "/%6Cayouts",
      headers: { ...AUTH, origin: ORIGIN },
    });
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("preflights do not consume the write or read limiters", async () => {
    h = await makeHub(ENV, () => 1_800_000_000_000); // frozen clock: no refill
    for (let i = 0; i < 50; i++) expect((await pre("/layouts/x", "PUT")).statusCode).toBe(204);
    for (let i = 0; i < 10; i++) {
      const r = await h.app.inject({
        method: "PUT",
        url: "/layouts/x",
        headers: AUTH,
        payload: body,
      });
      expect(r.statusCode).toBe(200);
    }
    expect(
      (await h.app.inject({ method: "PUT", url: "/layouts/x", headers: AUTH, payload: body }))
        .statusCode,
    ).toBe(429);
  });
});

describe("R6.3 CORS, empty allowlist", () => {
  it("sends no CORS headers and leaves OPTIONS as before", async () => {
    h = await makeHub({});
    const r = await pre("/layouts/x", "PUT");
    expect(r.statusCode).toBe(401);
    expect(r.body).toBe("");
    const plain = await h.app.inject({ method: "OPTIONS", url: "/layouts/x" });
    expect(plain.statusCode).toBe(401);
    const g = await h.app.inject({
      method: "GET",
      url: "/layouts",
      headers: { ...AUTH, origin: ORIGIN },
    });
    expect(g.statusCode).toBe(200);
    for (const res of [r, plain, g]) {
      expect(Object.keys(res.headers).filter((k) => k.startsWith("access-control"))).toEqual([]);
      expect(res.headers["vary"]).toBeUndefined();
    }
    const authed = await h.app.inject({
      method: "OPTIONS",
      url: "/layouts/x",
      headers: { ...AUTH, origin: ORIGIN, "access-control-request-method": "PUT" },
    });
    expect(authed.statusCode).toBe(404);
  });
});
