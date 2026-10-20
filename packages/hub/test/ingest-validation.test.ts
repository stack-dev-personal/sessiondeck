import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});

async function rejected(body: unknown, expectReason: string | RegExp) {
  const r = await h.post(body);
  expect(r.statusCode).toBe(400);
  const j = r.json<{ error: string; reason: string }>();
  expect(j.error).toBe("invalid_envelope");
  if (typeof expectReason === "string") expect(j.reason).toBe(expectReason);
  else expect(j.reason).toMatch(expectReason);
  expect(h.eventCount()).toBe(0);
  return r;
}

describe("R2.1 validation", () => {
  it("accepts a valid batch and reports accepted and last_seq", async () => {
    const r = await h.post(batch([mkEnv({ seq: 3 }), mkEnv({ seq: 9 })]));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ accepted: 2, last_seq: 9 });
  });

  it("missing field", async () => {
    const e = mkEnv() as unknown as Record<string, unknown>;
    delete e["ts"];
    await rejected(batch([e as never]), "envelopes[0].ts: Required");
  });

  it("bad kind is rejected without echoing the value", async () => {
    const r = await rejected(
      batch([mkEnv(), { ...mkEnv(), kind: "ECHO_ME_SECRET" } as never]),
      "envelopes[1].kind: Invalid enum value",
    );
    expect(r.body).not.toContain("ECHO_ME_SECRET");
  });

  it("bad ULID id", async () => {
    await rejected(batch([mkEnv({ id: "not-a-ulid" })]), "envelopes[0].id: id must be a ULID");
  });

  it("wrong version", async () => {
    await rejected(batch([{ ...mkEnv(), v: 2 } as never]), "envelopes[0].v: Invalid literal value");
  });

  it("host mismatch rejects the whole batch", async () => {
    await rejected(batch([mkEnv(), mkEnv({ host: "other" })]), "host_mismatch");
  });

  it("envelopes not an array", async () => {
    await rejected({ host: "h1", envelopes: {} }, "envelopes: Expected array, received object");
  });

  it("body not an object and missing host", async () => {
    await rejected([], "body: Expected object, received array");
    await rejected({ envelopes: [] }, "host: Required");
  });

  it("invalid JSON", async () => {
    const r = await h.postRaw("{not-json-ECHOME");
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "invalid_envelope", reason: "invalid_json" });
    expect(r.body).not.toContain("ECHOME");
  });

  it("a rejected batch stores nothing, not even its valid envelopes or the host", async () => {
    await rejected(batch([mkEnv(), mkEnv({ id: "bad" })]), /^envelopes\[1\]\.id/);
    expect(h.store.getHost("h1")).toBeUndefined();
    expect(h.store.getSession("s1")).toBeUndefined();
  });

  it("empty batch is a 200 with accepted 0", async () => {
    const r = await h.post(batch([]));
    expect(r.json()).toEqual({ accepted: 0, last_seq: 0 });
  });

  it("accepts a body of exactly 1 MiB; 1 byte more is a 413 with a short body", async () => {
    const LIMIT = 1024 * 1024;
    const withLen = (target: number): string => {
      const env = mkEnv({ payload: { pad: "" } });
      const base = JSON.stringify(batch([env])).length;
      const pad = "x".repeat(target - base);
      return JSON.stringify(batch([{ ...env, payload: { pad } }]));
    };
    const ok = withLen(LIMIT);
    expect(Buffer.byteLength(ok)).toBe(LIMIT);
    expect((await h.postRaw(ok)).statusCode).toBe(200);
    const over = withLen(LIMIT + 1);
    expect(Buffer.byteLength(over)).toBe(LIMIT + 1);
    const r = await h.postRaw(over);
    expect(r.statusCode).toBe(413);
    expect(r.body.length).toBeLessThan(100);
    expect(h.eventCount()).toBe(1);
  });

  it("per-host rate limit: 429 with an empty body, buckets are per host and refill", async () => {
    await h.cleanup();
    let now = 1_000_000;
    h = await makeHub({ HUB_INGEST_RATE: "10", HUB_INGEST_BURST: "20" }, () => now);
    const twenty = Array.from({ length: 20 }, () => mkEnv());
    expect((await h.post(batch(twenty))).statusCode).toBe(200);
    const one = await h.post(batch([mkEnv()]));
    expect(one.statusCode).toBe(429);
    expect(one.body).toBe("");
    expect((await h.post(batch([mkEnv({ host: "h2" })], "h2"))).statusCode).toBe(200);
    now += 1000; // 10 tokens
    expect((await h.post(batch([mkEnv()]))).statusCode).toBe(200);
    expect(h.eventCount()).toBe(22);
  });

  it("unauthenticated request with a malformed JSON body gets an empty 401", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect(r.statusCode).toBe(401);
    expect(r.body).toBe("");
    const bad = await h.app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      payload: "{broken",
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toBe("");
  });
});
