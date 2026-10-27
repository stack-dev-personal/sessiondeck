import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.ts";
import { migrations } from "../src/db/migrations.ts";
import { AUTH, makeHub, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub({}, () => 1_800_000_000_000);
});
afterEach(async () => {
  await h.cleanup();
});

const spec = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  root: { kind: "split", ratio: 0.333333333333, children: [{ kind: "pane" }, { kind: "pane" }] },
  ...extra,
});
const body = (o: Record<string, unknown> = {}) => ({
  name: "L",
  hotkey: null,
  host: null,
  spec: spec(),
  ...o,
});
const put = (id: string, b: unknown, headers: Record<string, string> = AUTH) =>
  h.app.inject({ method: "PUT", url: `/layouts/${id}`, headers, payload: b as object });
const list = async (q = "") =>
  (
    (await h.app.inject({ method: "GET", url: `/layouts${q}`, headers: AUTH })).json() as {
      layouts: { id: string; hotkey: number | null; host: string | null }[];
    }
  ).layouts;

describe("R6.3 layouts migration", () => {
  it("applies on a fresh DB and on a DB at the previous version", () => {
    const fresh = Store.open(":memory:");
    expect(fresh.migrate().length).toBe(migrations.length);
    const cols = (fresh.db.prepare("PRAGMA table_info(layouts)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(["hotkey", "host", "updated_at"]));
    fresh.close();

    const old = Store.open(":memory:");
    const last = migrations[migrations.length - 1]!;
    for (const m of migrations.slice(0, -1)) {
      old.db.exec(m.sql);
      old.db
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)")
        .run(m.version, m.name);
    }
    old.db
      .prepare("INSERT INTO layouts (id, name, spec, builtin) VALUES ('x', 'n', '{}', 0)")
      .run();
    expect(old.migrate()).toEqual([last.version]);
    expect(old.db.prepare("SELECT hotkey, host FROM layouts").get()).toEqual({
      hotkey: null,
      host: null,
    });
    old.close();
  });
});

describe("R6.3 layouts API", () => {
  it("requires auth on every route, with an empty 401", async () => {
    for (const [method, url] of [
      ["GET", "/layouts"],
      ["PUT", "/layouts/a"],
      ["DELETE", "/layouts/a"],
    ] as const) {
      for (const headers of [{}, { authorization: "Bearer wrong" }]) {
        const r = await h.app.inject({
          method,
          url,
          headers,
          payload: method === "PUT" ? body() : undefined,
        });
        expect(r.statusCode).toBe(401);
        expect(r.body).toBe("");
      }
    }
    expect(await list()).toEqual([]);
  });

  it("round-trips with the spec preserved exactly", async () => {
    const b = body({ name: "Three", hotkey: 3 });
    const r = await put("three", b);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: "three", name: "Three", hotkey: 3, host: null });
    const got = (await list())[0] as unknown as { spec: unknown };
    expect(JSON.stringify(got.spec)).toBe(JSON.stringify(b.spec));
    const raw = h.store.db.prepare("SELECT spec FROM layouts WHERE id = 'three'").get() as {
      spec: string;
    };
    expect(raw.spec).toContain("0.333333333333");
    await put("three", body({ name: "Renamed" }));
    const all = await list();
    expect(all).toHaveLength(1);
    expect((all[0] as unknown as { name: string }).name).toBe("Renamed");
  });

  it("moves a hotkey within a host scope and keeps host scopes independent", async () => {
    await put("a", body({ hotkey: 1 }));
    await put("b", body({ hotkey: 1, host: "h1" }));
    expect((await list()).map((l) => [l.id, l.hotkey]).sort()).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    await put("c", body({ hotkey: 1 }));
    const m = new Map((await list()).map((l) => [l.id, l.hotkey]));
    expect(m.get("a")).toBeNull();
    expect(m.get("c")).toBe(1);
    expect(m.get("b")).toBe(1);
    expect((await put("c", body({ hotkey: 1 }))).statusCode).toBe(200);
    expect(new Map((await list()).map((l) => [l.id, l.hotkey])).get("c")).toBe(1);
  });

  it("filters by host: pinned plus unpinned", async () => {
    await put("all", body());
    await put("p1", body({ host: "h1" }));
    await put("p2", body({ host: "h2" }));
    expect((await list("?host=h1")).map((l) => l.id).sort()).toEqual(["all", "p1"]);
    expect((await list()).map((l) => l.id).sort()).toEqual(["all", "p1", "p2"]);
  });

  it("rejects invalid writes with 400 and stores nothing", async () => {
    const deep: Record<string, unknown> = { kind: "pane" };
    let cur = deep;
    for (let i = 0; i < 20; i++) {
      const n: Record<string, unknown> = {};
      cur["child"] = n;
      cur = n;
    }
    const cases: [string, string, unknown][] = [
      ["bad id", "a.b", body()],
      ["long id", "x".repeat(65), body()],
      ["hotkey 0", "a", body({ hotkey: 0 })],
      ["hotkey 10", "a", body({ hotkey: 10 })],
      ["hotkey frac", "a", body({ hotkey: 1.5 })],
      ["empty name", "a", body({ name: "" })],
      ["long host", "a", body({ host: "h".repeat(129) })],
      ["oversized", "a", body({ spec: spec({ pad: "x".repeat(33 * 1024) }) })],
      ["deep", "a", body({ spec: { version: 1, root: deep } })],
      ["array spec", "a", body({ spec: [1] })],
      ["string spec", "a", body({ spec: "x" })],
      ["no version", "a", body({ spec: { root: {} } })],
      ["no root", "a", body({ spec: { version: 1 } })],
      ["root not object", "a", body({ spec: { version: 1, root: 3 } })],
      ["builtin flag", "a", body({ builtin: 1 })],
    ];
    for (const [label, id, b] of cases) {
      expect((await put(id, b)).statusCode, label).toBe(400);
    }
    expect(await list()).toEqual([]);
  });

  it("does not let the API write or delete builtin rows", async () => {
    h.store.db
      .prepare("INSERT INTO layouts (id, name, spec, builtin) VALUES ('core', 'Core', '{}', 1)")
      .run();
    expect((await put("core", body())).statusCode).toBe(403);
    expect(
      (await h.app.inject({ method: "DELETE", url: "/layouts/core", headers: AUTH })).statusCode,
    ).toBe(403);
    expect(await list()).toEqual([]);
  });

  it("deletes with 204 then 404", async () => {
    await put("a", body());
    const d = () => h.app.inject({ method: "DELETE", url: "/layouts/a", headers: AUTH });
    expect((await d()).statusCode).toBe(204);
    expect((await d()).statusCode).toBe(404);
  });

  it("caps the total number of saved layouts", async () => {
    for (let i = 0; i < 200; i++) {
      h.store.db
        .prepare("INSERT INTO layouts (id, name, spec, builtin) VALUES (?, 'n', '{}', 0)")
        .run(`s${i}`);
    }
    expect((await put("new", body())).statusCode).toBe(409);
    expect((await put("s5", body())).statusCode).toBe(200);
  });

  it("GET /layouts with 50 saved layouts is fast (hub share of the 100 ms switch budget)", async () => {
    for (let i = 0; i < 50; i++) {
      await put(`l${i}`, body({ name: `L${i}`, hotkey: i < 9 ? i + 1 : null }));
    }
    const ms: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      const r = await h.app.inject({ method: "GET", url: "/layouts", headers: AUTH });
      ms.push(performance.now() - t);
      expect(r.statusCode).toBe(200);
    }
    ms.sort((a, b) => a - b);
    const p50 = ms[24]!;
    const p95 = ms[47]!;
    console.log(`GET /layouts x50 (50 layouts): p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(50);
  });
});
