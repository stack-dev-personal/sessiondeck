// R2.10. Expected values in test/fixtures/transcripts/expected.json come from ccusage 19.0.3 run
// through scripts/ccusage-compare.mjs on the synthetic transcripts (see its provenance block).
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";
import { tempStore } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import {
  CACHE_FILE_NAME,
  PricingProvider,
  bundledTable,
  loadPricing,
  refreshPricing,
} from "../src/pricing/loader.ts";
import { PricingTable, parseLiteLLM } from "../src/pricing/pricing.ts";
import { UsageService } from "../src/usage/service.ts";
import { UsageCollector, createUniqueHash, parseUsageLine } from "../src/usage/usage.ts";
import { hubReport, independentDelta } from "../scripts/compare-hub.ts";
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
function expectRow(got: HubRow | undefined, legacy: HubRow | undefined, want: Row, indep: number) {
  expect(got, want.id).toBeDefined();
  expect(legacy, want.id).toBeDefined();
  const g = got!;
  const l = legacy!;
  expect([g.input_tokens, g.output_tokens, g.cache_creation_tokens, g.cache_read_tokens]).toEqual([
    want.input,
    want.output,
    want.cacheCreation,
    want.cacheRead,
  ]);
  // Legacy (5-minute-only) pricing is ccusage's; split pricing adds exactly the 1-hour delta.
  expect(Math.abs(l.cost_usd - want.cost)).toBeLessThanOrEqual(want.cost * 0.01);
  const delta = g.cost_usd - l.cost_usd;
  expect(delta).toBeGreaterThanOrEqual(-1e-12);
  expect(Math.abs(delta - indep)).toBeLessThanOrEqual(1e-9 * Math.max(Math.abs(indep), 1e-12));
  expect(g.models).toEqual(want.models);
}

describe("cost history matches ccusage 19.0.3 (R2.10)", () => {
  for (const tz of Object.keys(expected.byTimezone))
    for (const order of ["file", "late"] as const) {
      it(`sessions and days in ${tz}, ${order} arrival: tokens exact, cost within 1%, models in order`, async () => {
        const want = expected.byTimezone[tz]!;
        const r = await hubReport({ dir: FX, pricingFile: PRICING, tz, order });
        const lg = await hubReport({
          dir: FX,
          pricingFile: PRICING,
          tz,
          order,
          legacyCacheWrites: true,
        });
        const ind = independentDelta({ dir: FX, pricingFile: PRICING, tz });
        // The fixture's one 1h row: 600 x (2 x 5e-6 - 6.25e-6) on claude-opus-5.
        expect(ind.total).toBeCloseTo(600 * 3.75e-6, 12);
        expect(r.sessions.length).toBe(want.sessions.length);
        for (const w of want.sessions) {
          const i = ind.bySession[w.id] ?? 0;
          expectRow(
            r.sessions.find((s) => s.session_id === w.id),
            lg.sessions.find((s) => s.session_id === w.id),
            w,
            i,
          );
          expectRow(r.sessionCost[w.id], lg.sessionCost[w.id], w, i);
        }
        expect(r.days.map((d) => d.date)).toEqual(want.days.map((d) => d.id).sort());
        for (const w of want.days) {
          expectRow(
            r.days.find((d) => d.date === w.id),
            lg.days.find((d) => d.date === w.id),
            w,
            ind.byDay[w.id] ?? 0,
          );
        }
      }, 60_000);
    }

  it("fixture covers the intended cases (guards against a silently weakened fixture)", () => {
    const text = readFileSync(
      path.join(FX, "projects/-synthetic-proj-a/11111111-aaaa-4bbb-8ccc-000000000001.jsonl"),
      "utf8",
    );
    expect(
      readFileSync(
        path.join(FX, "projects/-synthetic-proj-b/22222222-aaaa-4bbb-8ccc-000000000002.jsonl"),
        "utf8",
      ),
    ).toContain('"ephemeral_1h_input_tokens":600');
    expect(text).toContain('"<synthetic>"');
    expect(text).toContain('"costUSD"');
    expect(text).toContain('"speed":"fast"');
    expect(text).toContain("2026-01-02T00:00:30");
    expect(text.match(/"id":"msg_s1_a"/g)?.length).toBe(4);
    // cross-session duplicates (the resume case) and a tie broken by path order
    const resumed = readFileSync(
      path.join(FX, "projects/-synthetic-proj-b/00000000-aaaa-4bbb-8ccc-000000000003.jsonl"),
      "utf8",
    );
    expect(resumed).toContain('"id":"msg_s1_b"');
    expect(resumed).toContain('"id":"msg_s2_b"');
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
  const run = (rows: string[]) => {
    const c = new UsageCollector();
    rows.forEach((raw, i) => c.addRow({ session_id: i < 2 ? "a" : "b", raw }));
    return c.daily(table, "UTC")[0];
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
  it("dedups across sessions (a resumed transcript replays earlier messages)", () => {
    const rows = [line({ id: "m", out: 4 }), line({ id: "x", out: 1 }), line({ id: "m", out: 4 })];
    expect(run(rows)?.output_tokens).toBe(5);
  });
  it("the winner does not depend on the order rows arrive in", () => {
    const rows = [
      { session_id: "s1", project_dir: "/p/b", line_no: 4, raw: line({ id: "m", out: 9 }) },
      { session_id: "s2", project_dir: "/p/a", line_no: 7, raw: line({ id: "m", out: 9 }) },
      { session_id: "s3", project_dir: "/p/a", line_no: 1, raw: line({ id: "m", out: 3 }) },
    ];
    const winners = new Set<string>();
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [1, 2, 0],
    ]) {
      const c = new UsageCollector();
      order.forEach((i) => c.addRow(rows[i]!));
      const s = c.sessions(table, "UTC");
      expect(s.length).toBe(1);
      winners.add(s[0]!.session_id);
    }
    // equal totals: the file that sorts first by path (project dir "-p-a") wins, not by session id
    expect([...winners]).toEqual(["s2"]);
  });
  it("rejects negative, fractional and infinite counts and costs like any invalid line", () => {
    const base = (usage: object, extra: object = {}) =>
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { usage },
        ...extra,
      });
    expect(parseUsageLine(base({ input_tokens: 1, output_tokens: 2 }))).not.toBeNull();
    expect(parseUsageLine(base({ input_tokens: -1, output_tokens: 2 }))).toBeNull();
    expect(parseUsageLine(base({ input_tokens: 1.5, output_tokens: 2 }))).toBeNull();
    expect(
      parseUsageLine(
        '{"timestamp":"2026-01-01T00:00:00.000Z","message":{"usage":{"input_tokens":1e999,"output_tokens":1}}}',
      ),
    ).toBeNull();
    expect(parseUsageLine(base({ input_tokens: 1, output_tokens: 2 }, { costUSD: -3 }))).toBeNull();
    expect(
      parseUsageLine(
        '{"timestamp":"2026-01-01T00:00:00.000Z","costUSD":1e999,"message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      ),
    ).toBeNull();
  });
  it("pricing entries with negative or infinite rates are skipped; the lookup memo is bounded", () => {
    const m = parseLiteLLM({
      neg: { input_cost_per_token: -1 },
      inf: JSON.parse('{"input_cost_per_token":1e999}') as unknown,
      ok: { input_cost_per_token: 1 },
    });
    expect([...m.keys()]).toEqual(["ok"]);
    const t = new PricingTable(m, "t");
    for (let i = 0; i < 5000; i++) t.lookup(`junk-${i}`);
    expect((t as unknown as { memo: Map<string, unknown> }).memo.size).toBeLessThanOrEqual(1000);
    expect(t.lookup("ok")).not.toBeNull();
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
  it("fetch: the body is read as a stream and cut off past the cap (no content-length)", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(200));
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(chunk);
        if (pulled > 1000) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const warns: { reason?: string }[] = [];
    const r = await refreshPricing({
      cachePath: null,
      maxBytes: 1000,
      log: { info: () => {}, warn: (o) => warns.push(o) },
      fetchFn: async () => new Response(body, { status: 200 }),
    });
    expect(r).toBeNull();
    expect(warns[0]?.reason).toBe("body too large");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
    // counted in bytes: 3-byte characters exceed a cap that their UTF-16 length would not
    const multi = JSON.stringify({ "claude-é": { input_cost_per_token: 1 }, pad: "€".repeat(400) });
    expect(
      await refreshPricing({
        cachePath: null,
        maxBytes: 600,
        fetchFn: async () => new Response(multi, { status: 200 }),
      }),
    ).toBeNull();
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
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
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

describe("history index and limits", () => {
  const usageLine = (id: string, out: number, ts = "2026-03-01T12:00:00.000Z") =>
    JSON.stringify({
      timestamp: ts,
      requestId: `r-${id}`,
      message: {
        id,
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 10, output_tokens: out },
      },
    });
  const send = (
    h: Awaited<ReturnType<typeof makeHub>>,
    session: string,
    n: number,
    lines: string[],
    start = 0,
  ) =>
    h.post({
      host: "h1",
      envelopes: [
        {
          v: 1,
          id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, "0")}`,
          kind: "transcript",
          host: "h1",
          os: "linux",
          session_id: session,
          ts: 1_760_000_000_000 + n,
          seq: n,
          payload: { start_line: start, lines },
        },
      ],
    });

  it("a message replayed into a second session counts once, in both endpoints (F1)", async () => {
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
    try {
      await send(h, "orig", 1, [usageLine("m1", 50), usageLine("m2", 70)]);
      await send(h, "resumed", 2, [usageLine("m1", 50), usageLine("m3", 5)]);
      const get = async (u: string) =>
        (await h.app.inject({ method: "GET", url: u, headers: AUTH })).json() as Record<
          string,
          number
        >;
      const a = await get("/sessions/orig/cost?tz=UTC");
      const b = await get("/sessions/resumed/cost?tz=UTC");
      expect(a["output_tokens"]).toBe(120);
      expect(b["output_tokens"]).toBe(5);
      const days = (await get("/history/daily?tz=UTC")) as unknown as {
        days: { output_tokens: number }[];
      };
      expect(days.days[0]?.output_tokens).toBe(125);
    } finally {
      await h.cleanup();
    }
  });

  it("advances incrementally from the rowid mark and rebuilds identically from the DB", async () => {
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
    try {
      const svc = new UsageService(h.store);
      await send(h, "s", 1, [usageLine("m1", 50), "{}", usageLine("m2", 70)]);
      await svc.refresh();
      expect(svc.index.count).toBe(2);
      await send(h, "s", 2, [usageLine("m9", 1)], 10);
      const v = svc.index.version;
      await svc.refresh();
      expect(svc.index.count).toBe(3);
      expect(svc.index.version).toBeGreaterThan(v);
      const v2 = svc.index.version;
      await svc.refresh(); // nothing new: no change, memo stays valid
      expect(svc.index.version).toBe(v2);
      const fresh = new UsageService(h.store);
      await fresh.refresh();
      const t = bundledTable();
      expect(fresh.index.sessions(t, "UTC")).toEqual(svc.index.sessions(t, "UTC"));
    } finally {
      await h.cleanup();
    }
  });

  const statusLine = (
    h: Awaited<ReturnType<typeof makeHub>>,
    session: string,
    n: number,
    projectDir: string,
  ) =>
    h.post({
      host: "h1",
      envelopes: [
        {
          v: 1,
          id: `01ARZ3NDEKTSV4RRFFQ69G6F${String(n).padStart(2, "0")}`,
          kind: "statusline",
          host: "h1",
          os: "linux",
          session_id: session,
          ts: 1_760_000_000_000 + n,
          seq: n,
          payload: { session_id: session, cwd: projectDir, workspace: { project_dir: projectDir } },
        },
      ],
    });

  it("project_dir arriving after the lines gives the same result as a cold rebuild (G1)", async () => {
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
    try {
      const svc = new UsageService(h.store);
      // A (project /z) is known; B (UUID sorts first, project /a) holds an equal copy of m1 and
      // is indexed before its project_dir is known. ccusage's file order puts -a/B before -z/A.
      await statusLine(h, "aaaa-A", 1, "/z");
      await send(h, "aaaa-A", 2, [usageLine("m1", 50, "2026-03-01T23:30:00.000Z")]);
      await send(h, "0000-B", 3, [usageLine("m1", 50, "2026-03-02T01:00:00.000Z")]);
      await svc.refresh();
      const t = bundledTable();
      const before = svc.index.sessions(t, "UTC");
      await statusLine(h, "0000-B", 4, "/a");
      await svc.refresh();
      const after = svc.index.sessions(t, "UTC");
      const cold = new UsageService(h.store);
      await cold.refresh();
      expect(after).toEqual(cold.index.sessions(t, "UTC"));
      expect(svc.index.daily(t, "UTC")).toEqual(cold.index.daily(t, "UTC"));
      expect(before).not.toEqual(after); // the late project_dir really changed the winner
      expect(svc.index.sessions(t, "UTC", "0000-B")[0]?.output_tokens).toBe(50);
      expect(svc.index.sessions(t, "UTC", "aaaa-A")).toEqual([]);
      expect(svc.index.daily(t, "UTC")[0]?.date).toBe("2026-03-02");
    } finally {
      await h.cleanup();
    }
  });

  it("scans session projects only when a project_dir changed", async () => {
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
    try {
      const svc = new UsageService(h.store);
      await statusLine(h, "aaaa-A", 1, "/z");
      await send(h, "aaaa-A", 2, [usageLine("m1", 50, "2026-03-01T23:30:00.000Z")]);
      await svc.refresh();
      await svc.refresh(); // first check after a build records the version
      const scans = h.store.projectScans;
      await svc.refresh();
      await send(h, "aaaa-A", 3, [usageLine("m2", 5, "2026-03-01T23:31:00.000Z")]);
      await svc.refresh();
      expect(h.store.projectScans).toBe(scans); // new rows, no project change: no scan
      await statusLine(h, "aaaa-A", 4, "/y");
      await svc.refresh();
      expect(h.store.projectScans).toBe(scans + 1);
    } finally {
      await h.cleanup();
    }
  });

  it("HEAD /history/* is limited like GET (G3)", async () => {
    const t = 1_800_000_000_000;
    const h = await makeHub({}, () => t);
    try {
      const code = async (method: "GET" | "HEAD", u: string) =>
        (await h.app.inject({ method, url: u, headers: AUTH })).statusCode;
      expect(await code("HEAD", "/history/daily?tz=UTC&from=2026-01-01")).toBe(200);
      expect(await code("HEAD", "/history/daily?tz=UTC&from=2026-01-02")).toBe(200);
      expect(await code("HEAD", "/history/daily?tz=UTC&from=2026-01-03")).toBe(429);
      expect(await code("GET", "/history/daily?tz=UTC&from=2026-01-04")).toBe(429);
    } finally {
      await h.cleanup();
    }
  });

  it("swapping the pricing table re-prices without new rows (G6)", async () => {
    const t = tempStore();
    t.store.migrate();
    const config = loadConfig({ HUB_TOKEN: "t".repeat(24), HUB_PRICING_FETCH: "0" });
    const rate = (n: number) =>
      new PricingTable(parseLiteLLM({ "claude-sonnet-4-5": { output_cost_per_token: n } }), "t");
    const provider = new PricingProvider(rate(0.001));
    const app = buildServer({ config, store: t.store, pricing: provider });
    try {
      t.store.insertTranscriptLine({
        session_id: "s",
        agent_id: "",
        line_no: 0,
        ts: 1_760_000_000_000,
        raw: usageLine("m1", 1000),
      });
      const cost = async () =>
        (
          await app.inject({
            method: "GET",
            url: "/sessions/s/cost?tz=UTC",
            headers: AUTH,
          })
        ).json() as { cost_usd: number };
      expect((await cost()).cost_usd).toBeCloseTo(1, 9);
      provider.set(rate(0.002));
      expect((await cost()).cost_usd).toBeCloseTo(2, 9);
    } finally {
      await app.close();
      t.store.close();
    }
  });

  it("/history/sessions honors limit (default 100, max 1000) and sorts by cost", async () => {
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
    try {
      for (let i = 0; i < 3; i++)
        await send(h, `sess-${i}`, i + 1, [usageLine(`m${i}`, 10 + i * 1000)]);
      const get = (u: string) => h.app.inject({ method: "GET", url: u, headers: AUTH });
      const all = (await get("/history/sessions?tz=UTC")).json() as {
        sessions: { session_id: string }[];
      };
      expect(all.sessions.map((s) => s.session_id)).toEqual(["sess-2", "sess-1", "sess-0"]);
      const two = (await get("/history/sessions?tz=UTC&limit=2")).json() as {
        sessions: unknown[];
      };
      expect(two.sessions.length).toBe(2);
      expect((await get("/history/sessions?limit=0")).statusCode).toBe(400);
      expect((await get("/history/sessions?limit=1001")).statusCode).toBe(400);
    } finally {
      await h.cleanup();
    }
  });

  it("/history/* has its own low limit (default burst 2, 1/s); other reads are unaffected", async () => {
    let t = 1_800_000_000_000;
    const h = await makeHub({}, () => t);
    try {
      const code = async (u: string) =>
        (await h.app.inject({ method: "GET", url: u, headers: AUTH })).statusCode;
      expect(await code("/history/daily?tz=UTC")).toBe(200);
      expect(await code("/history/sessions?tz=UTC")).toBe(200);
      expect(await code("/history/daily?tz=UTC")).toBe(429);
      expect(await code("/sessions")).toBe(200);
      t += 1000;
      expect(await code("/history/daily?tz=UTC")).toBe(200);
    } finally {
      await h.cleanup();
    }
  });
});

describe("cache write TTL split and unpriced models (R2.10, decision 25)", () => {
  const OPUS = "claude-opus-5-5";
  const table = new PricingTable(
    parseLiteLLM({
      [OPUS]: {
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.00002,
        cache_creation_input_token_cost: 0.000005,
        cache_read_input_token_cost: 2e-7,
      },
    }),
    "test",
  );
  const MTOK = 1_000_000;
  const row = (id: string, usage: Record<string, unknown>, model = OPUS) =>
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { id, model, usage: { input_tokens: 0, output_tokens: 0, ...usage } },
    });
  const costOf = (raw: string, t = table) => {
    const c = new UsageCollector();
    c.addRow({ session_id: "s", raw });
    return c.sessions(t, "UTC")[0]!;
  };

  it("prices 1h writes at 8 USD/MTok and 5m writes at 5 USD/MTok (opus-5-5)", () => {
    const r = costOf(
      row("a", {
        cache_creation_input_tokens: 3 * MTOK,
        cache_creation: {
          ephemeral_1h_input_tokens: 1 * MTOK,
          ephemeral_5m_input_tokens: 2 * MTOK,
        },
      }),
    );
    expect(r.cost_usd).toBeCloseTo(8 + 2 * 5, 9);
    expect(r.cache_creation_tokens).toBe(3 * MTOK);
    expect(
      costOf(
        row("b", {
          cache_creation_input_tokens: MTOK,
          cache_creation: { ephemeral_1h_input_tokens: MTOK, ephemeral_5m_input_tokens: 0 },
        }),
      ).cost_usd,
    ).toBeCloseTo(8, 9);
    // input 4 and output 20 / MTok are untouched by the split.
    expect(costOf(row("c", { input_tokens: MTOK, output_tokens: MTOK })).cost_usd).toBeCloseTo(
      24,
      9,
    );
  });
  it("a 5m-only split equals the old behavior", () => {
    const r = costOf(
      row("a", {
        cache_creation_input_tokens: MTOK,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: MTOK },
      }),
    );
    expect(r.cost_usd).toBeCloseTo(5, 9);
  });
  it("without a split every cache write is priced at the 5m rate", () => {
    expect(costOf(row("a", { cache_creation_input_tokens: MTOK })).cost_usd).toBeCloseTo(5, 9);
  });
  it("remainder rule: the split is priced and any uncovered remainder goes to the 5m rate", () => {
    const rem = costOf(
      row("a", {
        cache_creation_input_tokens: 3 * MTOK,
        cache_creation: { ephemeral_1h_input_tokens: MTOK },
      }),
    );
    expect(rem.cost_usd).toBeCloseTo(8 + 2 * 5, 9);
    // Split larger than the total: the split wins.
    const over = costOf(
      row("b", {
        cache_creation_input_tokens: MTOK,
        cache_creation: {
          ephemeral_1h_input_tokens: MTOK,
          ephemeral_5m_input_tokens: MTOK,
        },
      }),
    );
    expect(over.cost_usd).toBeCloseTo(8 + 5, 9);
  });
  it("an explicit 1h table field wins over 2x input; above-200k derives 2x the above-200k input", () => {
    const t = new PricingTable(
      parseLiteLLM({
        a: {
          input_cost_per_token: 0.000004,
          cache_creation_input_token_cost: 0.000005,
          cache_creation_input_token_cost_above_1hr: 0.00001,
        },
        b: {
          input_cost_per_token: 0.000003,
          input_cost_per_token_above_200k_tokens: 0.000006,
          cache_creation_input_token_cost: 0.00000375,
          cache_creation_input_token_cost_above_200k_tokens: 0.0000075,
        },
      }),
      "t",
    );
    const usage = (n: number) => ({
      cache_creation_input_tokens: n,
      cache_creation: { ephemeral_1h_input_tokens: n },
    });
    expect(costOf(row("a", usage(MTOK), "a"), t).cost_usd).toBeCloseTo(10, 9);
    // 300k all 1h: 200k at 2x3=6/MTok, 100k at 2x6=12/MTok.
    expect(costOf(row("b", usage(300_000), "b"), t).cost_usd).toBeCloseTo(1.2 + 1.2, 9);
  });
  it("fast mode multiplies the split-priced result", () => {
    const t = new PricingTable(
      parseLiteLLM({
        f: {
          input_cost_per_token: 0.000004,
          cache_creation_input_token_cost: 0.000005,
          provider_specific_entry: { fast: 6 },
        },
      }),
      "t",
    );
    const r = costOf(
      row(
        "a",
        {
          speed: "fast",
          cache_creation_input_tokens: MTOK,
          cache_creation: { ephemeral_1h_input_tokens: MTOK },
        },
        "f",
      ),
      t,
    );
    expect(r.cost_usd).toBeCloseTo(48, 9);
  });
  it("splitCacheWrites=false reproduces ccusage (all writes at 5m)", () => {
    const legacy = new PricingTable(table.models, "t", false);
    const raw = row("a", {
      cache_creation_input_tokens: MTOK,
      cache_creation: { ephemeral_1h_input_tokens: MTOK },
    });
    expect(costOf(raw, legacy).cost_usd).toBeCloseTo(5, 9);
  });

  it("an unknown model is logged once per process and listed in the cost responses", async () => {
    const warn: { model: string }[] = [];
    const h = await makeHub({ HUB_HISTORY_BURST: "100" });
    try {
      // Capture the service logger by wrapping warn on the app logger.
      const orig = h.app.log.warn.bind(h.app.log);
      (h.app.log as unknown as { warn: unknown }).warn = (
        o: { model?: string },
        ...rest: unknown[]
      ) => {
        if (o && typeof o === "object" && "model" in o) warn.push({ model: String(o.model) });
        return (orig as (...a: unknown[]) => unknown)(o, ...rest);
      };
      const lines = ["m1", "m2", "m3"].map((id, i) =>
        JSON.stringify({
          timestamp: `2026-03-01T12:00:0${i}.000Z`,
          message: {
            id,
            model: "acme-unpriced-1",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      );
      const priced = JSON.stringify({
        timestamp: "2026-03-01T12:00:09.000Z",
        message: {
          id: "m4",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1000, output_tokens: 10 },
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
            session_id: "sess-u",
            ts: 1_760_000_000_000,
            seq: 1,
            payload: { start_line: 0, lines: [...lines, priced] },
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      const get = (u: string) => h.app.inject({ method: "GET", url: u, headers: AUTH });
      const s = (await get("/sessions/sess-u/cost?tz=UTC")).json() as { unpricedModels: string[] };
      expect(s.unpricedModels).toEqual(["acme-unpriced-1"]);
      const d = (await get("/history/daily?tz=UTC")).json() as {
        days: { unpricedModels: string[] }[];
      };
      expect(d.days[0]!.unpricedModels).toEqual(["acme-unpriced-1"]);
      const hs = (await get("/history/sessions?tz=UTC")).json() as {
        sessions: { unpricedModels: string[] }[];
      };
      expect(hs.sessions[0]!.unpricedModels).toEqual(["acme-unpriced-1"]);
      expect(warn.filter((w) => w.model === "acme-unpriced-1")).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
  it("a fully priced session reports an empty unpricedModels", () => {
    expect(costOf(row("a", { input_tokens: 5 })).unpricedModels).toEqual([]);
    expect(costOf(row("a", { input_tokens: 5 }, "acme-x")).unpricedModels).toEqual(["acme-x"]);
  });
});

describe("official prices on the bundled table (R2.10, decision 25)", () => {
  const bundled = bundledTable();
  const MTOK = 1_000_000;
  const rowOf = (id: string, model: string, usage: Record<string, unknown>, extra = {}) =>
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { id, model, usage: { input_tokens: 0, output_tokens: 0, ...usage }, ...extra },
    });
  const costOf = (raw: string, t: PricingTable = bundled) => {
    const c = new UsageCollector();
    c.addRow({ session_id: "s", raw });
    return c.sessions(t, "UTC")[0]!;
  };
  // USD per MTok, from the official price list: opus-5-5 in 4, 5m write 5, 1h write 8, read 0.20,
  // out 20; fable-5-1 in 10, 5m write 12.50, 1h write 20, read 0.25, out 50.
  const all = (model: string, extra = {}) =>
    costOf(
      rowOf(
        "a",
        model,
        {
          input_tokens: MTOK,
          output_tokens: MTOK,
          cache_read_input_tokens: MTOK,
          cache_creation_input_tokens: 2 * MTOK,
          cache_creation: { ephemeral_1h_input_tokens: MTOK, ephemeral_5m_input_tokens: MTOK },
        },
        extra,
      ),
    ).cost_usd;

  it("opus 5.5: 1-hour and 5-minute writes, read, input, output", () => {
    // 4 + 20 + 0.20 + 8 (1h) + 5 (5m)
    expect(all("claude-opus-5-5")).toBeCloseTo(37.2, 9);
  });
  it("fable 5.1: 1-hour and 5-minute writes, read, input, output", () => {
    // 10 + 50 + 0.25 + 20 (1h) + 12.5 (5m)
    expect(all("claude-fable-5-1")).toBeCloseTo(92.75, 9);
  });
  it("5-minute-only split and no split price at the 5-minute rate", () => {
    const five = rowOf("a", "claude-opus-5-5", {
      cache_creation_input_tokens: MTOK,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: MTOK },
    });
    const none = rowOf("b", "claude-fable-5-1", { cache_creation_input_tokens: MTOK });
    expect(costOf(five).cost_usd).toBeCloseTo(5, 9);
    expect(costOf(none).cost_usd).toBeCloseTo(12.5, 9);
  });
  it("fast mode multiplies by the table's fast factor (opus 5.5: 2x)", () => {
    expect(bundled.lookup("claude-opus-5-5")?.provider_specific_entry?.fast).toBe(2);
    const fast = costOf(
      rowOf("f", "claude-opus-5-5", {
        speed: "fast",
        input_tokens: MTOK,
        output_tokens: MTOK,
        cache_creation_input_tokens: MTOK,
        cache_creation: { ephemeral_1h_input_tokens: MTOK },
      }),
    ).cost_usd;
    // (4 + 20 + 8) x 2
    expect(fast).toBeCloseTo(64, 9);
    // A model with no fast factor is not multiplied.
    const noFast = costOf(
      rowOf("g", "claude-fable-5-1", { speed: "fast", input_tokens: MTOK }),
    ).cost_usd;
    expect(noFast).toBeCloseTo(10, 9);
  });
  it("high effort: thinking tokens are inside output_tokens and priced once", () => {
    const raw = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      effort: "high",
      message: {
        id: "t",
        model: "claude-opus-5-5",
        content: [
          { type: "thinking", thinking: "x".repeat(5000) },
          { type: "text", text: "done" },
        ],
        usage: { input_tokens: 0, output_tokens: 150_000, thinking_tokens: 120_000 },
      },
    });
    // 150000 x 20 / MTok = 3.00 exactly; thinking_tokens is never added on top.
    expect(costOf(raw).cost_usd).toBeCloseTo(3, 12);
    expect(costOf(raw).output_tokens).toBe(150_000);
  });
  it("an unknown model is unpriced (cost 0, listed)", () => {
    const r = costOf(rowOf("u", "acme-unpriced-1", { input_tokens: MTOK }));
    expect(r.cost_usd).toBe(0);
    expect(r.unpricedModels).toEqual(["acme-unpriced-1"]);
  });
  it("every priced model id in the fixtures resolves by exact match in the bundled snapshot", () => {
    const roots = [
      path.resolve(import.meta.dirname, "../../contract/fixtures/transcripts"),
      path.resolve(import.meta.dirname, "fixtures"),
    ];
    const ids = new Set<string>();
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith(".jsonl")) {
          for (const m of readFileSync(f, "utf8").matchAll(/"model":\s*"([^"]+)"/g)) ids.add(m[1]!);
        }
      }
    };
    roots.forEach(walk);
    const priced = [...ids].filter((m) => m !== "<synthetic>" && m !== "acme-unpriced-1");
    expect(priced.length).toBeGreaterThanOrEqual(8);
    for (const m of priced) expect({ m, kind: bundled.matchKind(m) }).toEqual({ m, kind: "exact" });
    expect(bundled.matchKind("acme-unpriced-1")).toBeNull();
  });
});
