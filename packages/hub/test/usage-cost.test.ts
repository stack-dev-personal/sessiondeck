// R2.10. Expected values in test/fixtures/transcripts/expected.json come from ccusage 19.0.3 run
// through scripts/ccusage-compare.mjs on the synthetic transcripts (see its provenance block).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  CACHE_FILE_NAME,
  bundledTable,
  loadPricing,
  refreshPricing,
} from "../src/pricing/loader.ts";
import { PricingTable, parseLiteLLM } from "../src/pricing/pricing.ts";
import { UsageCollector, createUniqueHash, parseUsageLine } from "../src/usage/usage.ts";
import { hubReport } from "../scripts/compare-hub.ts";
import { AUTH, makeHub } from "./support/hub.ts";

const FX = path.resolve(import.meta.dirname, "fixtures/transcripts");
const PRICING = path.join(FX, "pricing.json");

interface Row {
  id: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
  models: string[];
}
const expected = JSON.parse(readFileSync(path.join(FX, "expected.json"), "utf8")) as {
  byTimezone: Record<string, { sessions: Row[]; days: Row[] }>;
};

const tmpDirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hub-usage-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface HubRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  models: string[];
}
function expectRow(got: HubRow | undefined, want: Row) {
  expect(got, want.id).toBeDefined();
  const g = got!;
  expect([g.input_tokens, g.output_tokens, g.cache_creation_tokens, g.cache_read_tokens]).toEqual([
    want.input,
    want.output,
    want.cacheCreation,
    want.cacheRead,
  ]);
  expect(Math.abs(g.cost_usd - want.cost)).toBeLessThanOrEqual(want.cost * 0.01);
  expect([...g.models].sort()).toEqual(want.models);
}

describe("cost history matches ccusage 19.0.3 (R2.10)", () => {
  for (const tz of Object.keys(expected.byTimezone)) {
    it(`sessions and days in ${tz}: tokens exact, cost within 1%`, async () => {
      const want = expected.byTimezone[tz]!;
      const r = await hubReport({ dir: FX, pricingFile: PRICING, tz });
      expect(r.sessions.length).toBe(want.sessions.length);
      for (const w of want.sessions) {
        expectRow(
          r.sessions.find((s) => s.session_id === w.id),
          w,
        );
        expectRow(r.sessionCost[w.id], w);
      }
      expect(r.days.map((d) => d.date)).toEqual(want.days.map((d) => d.id).sort());
      for (const w of want.days) {
        expectRow(
          r.days.find((d) => d.date === w.id),
          w,
        );
      }
    }, 60_000);
  }

  it("fixture covers the intended cases (guards against a silently weakened fixture)", () => {
    const text = readFileSync(
      path.join(FX, "projects/-synthetic-proj-a/11111111-aaaa-4bbb-8ccc-000000000001.jsonl"),
      "utf8",
    );
    expect(text).toContain('"<synthetic>"');
    expect(text).toContain('"costUSD"');
    expect(text).toContain('"speed":"fast"');
    expect(text).toContain("2026-01-02T00:00:30");
    expect(text.match(/"id":"msg_s1_a"/g)?.length).toBe(4);
    expect(expected.byTimezone["UTC"]?.days.length).toBe(3);
  });
});

describe("dedup rules (ccusage createUniqueHash and shouldReplaceEntryMetadata)", () => {
  const line = (o: {
    id?: string;
    req?: string;
    out: number;
    speed?: string;
    model?: string;
    cost?: number;
  }) =>
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      ...(o.req ? { requestId: o.req } : {}),
      ...(o.cost !== undefined ? { costUSD: o.cost } : {}),
      message: {
        ...(o.id ? { id: o.id } : {}),
        model: o.model ?? "claude-haiku-4-5-20251001",
        usage: { input_tokens: 1, output_tokens: o.out, ...(o.speed ? { speed: o.speed } : {}) },
      },
    });
  const table = new PricingTable(parseLiteLLM(JSON.parse(readFileSync(PRICING, "utf8"))), "test");
  const run = (rows: string[], scope: "global" | "session" = "global") => {
    const c = new UsageCollector(table, "UTC", scope);
    rows.forEach((raw, i) => c.addRow({ session_id: i < 2 ? "a" : "b", raw }));
    return c.daily()[0];
  };

  it("hash is message.id[:requestId]; null without a message id", () => {
    const p = (s: string) => parseUsageLine(s)!;
    expect(createUniqueHash(p(line({ id: "m", req: "r", out: 1 })))).toBe("m:r");
    expect(createUniqueHash(p(line({ id: "m", out: 1 })))).toBe("m");
    expect(createUniqueHash(p(line({ out: 1 })))).toBeNull();
  });
  it("keeps the larger total regardless of order; a tie keeps the first", () => {
    expect(
      run([line({ id: "m", req: "r", out: 5 }), line({ id: "m", req: "r", out: 50 })])
        ?.output_tokens,
    ).toBe(50);
    expect(
      run([line({ id: "m", req: "r", out: 50 }), line({ id: "m", req: "r", out: 5 })])
        ?.output_tokens,
    ).toBe(50);
    expect(
      run([line({ id: "m", req: "r", out: 7 }), line({ id: "m", req: "r", out: 7 })])
        ?.output_tokens,
    ).toBe(7);
  });
  it("rows without a message id are never deduplicated", () => {
    expect(run([line({ out: 3 }), line({ out: 3 })])?.output_tokens).toBe(6);
  });
  it("on a token tie a row that carries speed replaces one that does not", () => {
    const d = run([line({ id: "m", out: 9 }), line({ id: "m", out: 9, speed: "standard" })]);
    expect(d?.output_tokens).toBe(9);
  });
  it("global scope dedups across sessions, session scope does not", () => {
    const rows = [line({ id: "m", out: 4 }), line({ id: "x", out: 1 }), line({ id: "m", out: 4 })];
    expect(run(rows, "global")?.output_tokens).toBe(5);
    expect(run(rows, "session")?.output_tokens).toBe(9);
  });
  it("costUSD wins over pricing (mode auto), and an unknown model costs 0", () => {
    expect(run([line({ id: "m", out: 1000, cost: 0.5 })])?.cost_usd).toBe(0.5);
    expect(run([line({ id: "n", out: 1000, model: "acme-unpriced-1" })])?.cost_usd).toBe(0);
  });
  it("skips lines without a usage block or with a schema mismatch", () => {
    expect(parseUsageLine("not json")).toBeNull();
    expect(parseUsageLine('{"type":"user","message":{"content":"x"}}')).toBeNull();
    expect(
      parseUsageLine(
        '{"timestamp":"yesterday","message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      ),
    ).toBeNull();
  });
});

describe("pricing sources", () => {
  it("bundled snapshot loads and prices a current model", () => {
    const t = bundledTable();
    expect(t.models.size).toBeGreaterThan(100);
    expect(
      t.cost({ input_tokens: 1_000_000, output_tokens: 0 }, "claude-sonnet-4-5", undefined),
    ).toBeCloseTo(3, 6);
  });
  it("precedence: HUB_PRICING_FILE > cache > bundled", () => {
    const dir = mkTmp();
    const cache = path.join(dir, CACHE_FILE_NAME);
    expect(loadPricing({ cachePath: cache }).source).toBe("bundled");
    writeFileSync(
      cache,
      JSON.stringify({
        fetched_at: 1,
        url: "u",
        models: { "claude-x": { input_cost_per_token: 1 } },
      }),
    );
    const fromCache = loadPricing({ cachePath: cache });
    expect(fromCache.source).toBe(`cache:${cache}`);
    expect(fromCache.models.has("claude-x")).toBe(true);
    const f = loadPricing({ file: PRICING, cachePath: cache });
    expect(f.source).toBe(`file:${PRICING}`);
    expect(f.models.has("claude-x")).toBe(false);
  });
  it("a corrupt cache falls back to bundled; a bad explicit file throws", () => {
    const dir = mkTmp();
    const cache = path.join(dir, CACHE_FILE_NAME);
    writeFileSync(cache, "{nope");
    const warns: object[] = [];
    const t = loadPricing({
      cachePath: cache,
      log: { info: () => {}, warn: (o) => warns.push(o) },
    });
    expect(t.source).toBe("bundled");
    expect(warns.length).toBe(1);
    expect(() => loadPricing({ file: path.join(dir, "missing.json") })).toThrow();
    writeFileSync(path.join(dir, "empty.json"), "{}");
    expect(() => loadPricing({ file: path.join(dir, "empty.json") })).toThrow(/no model prices/);
  });
  it("fetch: validated, cached, never throws", async () => {
    const dir = mkTmp();
    const cache = path.join(dir, CACHE_FILE_NAME);
    const body = JSON.stringify({
      sample_spec: { input_cost_per_token: "not a number" },
      "claude-fetched": { input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 },
    });
    const ok = await refreshPricing({
      cachePath: cache,
      fetchFn: async () => new Response(body, { status: 200 }),
    });
    expect(ok?.source).toBe("fetch");
    expect([...ok!.models.keys()]).toEqual(["claude-fetched"]);
    expect(loadPricing({ cachePath: cache }).models.has("claude-fetched")).toBe(true);

    const warns: object[] = [];
    const log = { info: () => {}, warn: (o: object) => warns.push(o) };
    for (const fetchFn of [
      async () => new Response("<html>", { status: 200 }),
      async () => new Response("{}", { status: 200 }),
      async () => new Response("[]", { status: 200 }),
      async () => new Response("x", { status: 503 }),
      async () => {
        throw new Error("offline");
      },
    ]) {
      expect(await refreshPricing({ cachePath: null, log, fetchFn })).toBeNull();
    }
    expect(warns.length).toBe(5);
  });
  it("fetch honors the timeout", async () => {
    const t0 = Date.now();
    const r = await refreshPricing({
      cachePath: null,
      timeoutMs: 50,
      fetchFn: (_u, init) =>
        new Promise((_res, rej) => {
          (init?.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")));
        }),
    });
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("config: HUB_PRICING_FETCH defaults on, accepts 0/1, rejects junk; HUB_TIMEZONE validated", () => {
    const base = { HUB_TOKEN: "a".repeat(16) };
    expect(loadConfig(base).pricingFetch).toBe(true);
    expect(loadConfig({ ...base, HUB_PRICING_FETCH: "0" }).pricingFetch).toBe(false);
    expect(() => loadConfig({ ...base, HUB_PRICING_FETCH: "maybe" })).toThrow(/HUB_PRICING_FETCH/);
    expect(loadConfig({ ...base, HUB_PRICING_FILE: "/p.json" }).pricingFile).toBe("/p.json");
    expect(loadConfig({ ...base, HUB_TIMEZONE: "Asia/Tokyo" }).timezone).toBe("Asia/Tokyo");
    expect(() => loadConfig({ ...base, HUB_TIMEZONE: "Mars/Base" })).toThrow(/HUB_TIMEZONE/);
  });
});

describe("REST", () => {
  it("requires auth, validates queries, 404s unknown sessions, returns shapes", async () => {
    const h = await makeHub();
    try {
      for (const url of ["/sessions/x/cost", "/history/daily", "/history/sessions"]) {
        const r = await h.app.inject({ method: "GET", url });
        expect(r.statusCode).toBe(401);
        expect(r.body).toBe("");
      }
      const get = (url: string) => h.app.inject({ method: "GET", url, headers: AUTH });
      expect((await get("/sessions/nope/cost")).statusCode).toBe(404);
      expect((await get("/history/daily?from=yesterday")).statusCode).toBe(400);
      expect((await get("/history/daily?tz=Mars/Base")).statusCode).toBe(400);
      const empty = (await get("/history/daily?tz=UTC")).json() as { tz: string; days: unknown[] };
      expect(empty).toEqual({ tz: "UTC", days: [] });

      const line = JSON.stringify({
        timestamp: "2026-03-01T12:00:00.000Z",
        requestId: "r1",
        message: {
          id: "m1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000 },
        },
      });
      const res = await h.post({
        host: "h1",
        envelopes: [
          {
            v: 1,
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            kind: "transcript",
            host: "h1",
            os: "linux",
            session_id: "sess-1",
            ts: 1_760_000_000_000,
            seq: 1,
            payload: { start_line: 0, lines: [line, "garbage"] },
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      const cost = (await get("/sessions/sess-1/cost?tz=UTC")).json() as Record<string, unknown>;
      expect(cost).toMatchObject({
        session_id: "sess-1",
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_tokens: 0,
        cache_read_tokens: 10000,
        total_tokens: 11100,
        models: ["claude-sonnet-4-5"],
        last_activity: "2026-03-01",
      });
      expect(cost["cost_usd"] as number).toBeCloseTo(0.003 + 0.0015 + 0.003, 9);
      const days = (await get("/history/daily?from=2026-03-01&to=2026-03-01&tz=UTC")).json() as {
        days: { date: string; cost_usd: number }[];
      };
      expect(days.days.map((d) => d.date)).toEqual(["2026-03-01"]);
      expect(
        ((await get("/history/daily?from=2026-03-02&tz=UTC")).json() as { days: unknown[] }).days,
      ).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});
