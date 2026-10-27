import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.ts";
import { migrations } from "../src/db/migrations.ts";
import { AUTH, makeHub, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  // Auto-advancing clock (1 s per read) so the layout write limiter refills between requests.
  let clock = 1_800_000_000_000;
  h = await makeHub({}, () => (clock += 1000));
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
      [
        "30k-deep array",
        "a",
        `{"name":"L","hotkey":null,"host":null,"spec":{"version":1,"root":{},"x":${"[".repeat(30000)}${"]".repeat(30000)}}}`,
      ],
      ["array spec", "a", body({ spec: [1] })],
      ["string spec", "a", body({ spec: "x" })],
      ["no version", "a", body({ spec: { root: {} } })],
      ["no root", "a", body({ spec: { version: 1 } })],
      ["root not object", "a", body({ spec: { version: 1, root: 3 } })],
      ["builtin flag", "a", body({ builtin: 1 })],
    ];
    for (const [label, id, b] of cases) {
      const r =
        typeof b === "string"
          ? await h.app.inject({
              method: "PUT",
              url: `/layouts/${id}`,
              headers: { ...AUTH, "content-type": "application/json" },
              payload: b,
            })
          : await put(id, b);
      expect(r.statusCode, label).toBe(400);
      if (typeof b === "string") expect(r.json()).toMatchObject({ error: "invalid_body" });
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

  it("rate limits layout writes per principal with 429, refills over time, leaves ingest and reads alone", async () => {
    let t = 1_800_000_000_000;
    const fixed = await makeHub({}, () => t);
    try {
      const w = (i: number) =>
        fixed.app.inject({
          method: "PUT",
          url: `/layouts/r${i}`,
          headers: AUTH,
          payload: body() as object,
        });
      for (let i = 0; i < 10; i++) expect((await w(i)).statusCode).toBe(200);
      expect((await w(10)).statusCode).toBe(429);
      const d = await fixed.app.inject({ method: "DELETE", url: "/layouts/r0", headers: AUTH });
      expect(d.statusCode).toBe(429);
      expect(d.body).toBe("");
      const g = await fixed.app.inject({ method: "GET", url: "/layouts", headers: AUTH });
      expect(g.statusCode).toBe(200);
      const ing = await fixed.app.inject({
        method: "POST",
        url: "/ingest",
        headers: AUTH,
        payload: { host: "h", events: [] } as object,
      });
      expect(ing.statusCode).not.toBe(429);
      t += 500; // 2/s refills one token
      expect((await w(11)).statusCode).toBe(200);
      expect((await w(12)).statusCode).toBe(429);
    } finally {
      await fixed.cleanup();
    }
  });

  it.each(["/%6Cayouts/x", "/%6cayouts/x"])(
    "percent-encoded path %s cannot skip the write limiter (PUT and DELETE)",
    async (url) => {
      const fixed = await makeHub({}, () => 1_800_000_000_000);
      try {
        for (let i = 0; i < 10; i++) {
          await fixed.app.inject({ method: "PUT", url, headers: AUTH, payload: body() as object });
        }
        const p = await fixed.app.inject({
          method: "PUT",
          url,
          headers: AUTH,
          payload: body() as object,
        });
        expect(p.statusCode).toBe(429);
        const d = await fixed.app.inject({ method: "DELETE", url, headers: AUTH });
        expect(d.statusCode).toBe(429);
      } finally {
        await fixed.cleanup();
      }
    },
  );

  it("PUT reports active_hotkey the same way the next GET does", async () => {
    const r = await put("k", body({ hotkey: 3, host: null }));
    expect((r.json() as { active_hotkey: boolean }).active_hotkey).toBe(true);
    const p = await put("pk", body({ hotkey: 4, host: "h1" }));
    expect((p.json() as { active_hotkey: boolean }).active_hotkey).toBe(true);
    const n = await put("nk", body({ hotkey: null }));
    expect((n.json() as { active_hotkey: boolean }).active_hotkey).toBe(false);
    const got = await list();
    expect(got.find((l) => l.id === "k")).toMatchObject({ active_hotkey: true });
  });

  it("active_hotkey: the pinned layout wins for its host", async () => {
    await put("u1", body({ hotkey: 1 }));
    await put("u2", body({ hotkey: 2 }));
    await put("p1", body({ hotkey: 1, host: "h1" }));
    await put("p3", body({ hotkey: 3, host: "h2" }));
    await put("none", body());
    const act = async (q: string) =>
      Object.fromEntries(
        (
          (await h.app.inject({ method: "GET", url: `/layouts${q}`, headers: AUTH })).json() as {
            layouts: { id: string; active_hotkey: boolean }[];
          }
        ).layouts.map((l) => [l.id, l.active_hotkey]),
      );
    expect(await act("?host=h1")).toEqual({ u1: false, u2: true, p1: true, none: false });
    expect(await act("?host=h3")).toEqual({ u1: true, u2: true, none: false });
    expect(await act("")).toEqual({ u1: true, u2: true, p1: false, p3: false, none: false });
  });

  it("moving a slot: occupant cleared, old slot freed, across pin changes", async () => {
    await put("a", body({ hotkey: 2, host: "h1" }));
    await put("c", body({ hotkey: 1, host: "h1" }));
    expect((await put("a", body({ hotkey: 1, host: "h1" }))).statusCode).toBe(200);
    let m = new Map((await list()).map((l) => [l.id, l.hotkey]));
    expect(m.get("a")).toBe(1);
    expect(m.get("c")).toBeNull();
    // slot 2 is free again
    expect((await put("d", body({ hotkey: 2, host: "h1" }))).statusCode).toBe(200);
    expect(new Map((await list()).map((l) => [l.id, l.hotkey])).get("d")).toBe(2);
    // a pinned row moving to no pin onto a taken slot
    await put("u", body({ hotkey: 5 }));
    await put("pp", body({ hotkey: 6, host: "h1" }));
    expect((await put("pp", body({ hotkey: 5, host: null }))).statusCode).toBe(200);
    m = new Map((await list()).map((l) => [l.id, l.hotkey]));
    expect(m.get("pp")).toBe(5);
    expect(m.get("u")).toBeNull();
  });

  it("a failed PUT rolls back and leaves prior rows unchanged", async () => {
    await put("keep", body({ hotkey: 4 }));
    for (let i = 0; i < 199; i++) {
      h.store.db
        .prepare("INSERT INTO layouts (id, name, spec, builtin) VALUES (?, 'n', '{}', 0)")
        .run(`s${i}`);
    }
    const before = JSON.stringify(h.store.db.prepare("SELECT * FROM layouts ORDER BY id").all());
    expect((await put("new", body({ hotkey: 4 }))).statusCode).toBe(409);
    expect(JSON.stringify(h.store.db.prepare("SELECT * FROM layouts ORDER BY id").all())).toBe(
      before,
    );
    // forced failure after the clearing UPDATE: unbindable name makes the INSERT throw
    h.store.db.prepare("DELETE FROM layouts WHERE id = 's0'").run();
    const mid = JSON.stringify(h.store.db.prepare("SELECT * FROM layouts ORDER BY id").all());
    const { putLayout } = await import("../src/db/layouts.ts");
    expect(() =>
      putLayout(
        h.store,
        { id: "other", name: {} as unknown as string, hotkey: 4, host: null, spec: "{}" },
        1,
      ),
    ).toThrow();
    expect(JSON.stringify(h.store.db.prepare("SELECT * FROM layouts ORDER BY id").all())).toBe(mid);
  });

  it("builtin rows never hold hotkeys: a seeded one is untouched by a user PUT to its slot", async () => {
    h.store.db
      .prepare(
        "INSERT INTO layouts (id, name, spec, builtin, hotkey) VALUES ('core', 'Core', '{}', 1, 7)",
      )
      .run();
    const r = await put("mine", body({ hotkey: 7 }));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "slot_reserved" });
    expect(
      h.store.db.prepare("SELECT hotkey, updated_at FROM layouts WHERE id = 'core'").get(),
    ).toEqual({
      hotkey: 7,
      updated_at: 0,
    });
    expect(await list()).toEqual([]);
  });
});
