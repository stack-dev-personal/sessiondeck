import { describe, expect, it } from "vitest";
import {
  describeError,
  HubError,
  httpBase,
  hubAdapter,
  memoryAdapter,
  parseRow,
  parseRows,
  resolveSlot,
  viewerHost,
  withPut,
  type SavedLayout,
} from "./saved";
import { buildPreset } from "./presets";
import { MAX_DEPTH, type LayoutSpec, type Node } from "./spec";

const wire = (
  id: string,
  extra: Record<string, unknown> = {},
  spec: unknown = buildPreset("pair"),
) => ({
  id,
  name: `L ${id}`,
  hotkey: null,
  host: null,
  spec,
  updated_at: 5,
  active_hotkey: false,
  ...extra,
});

const row = (id: string, hotkey: number | null, host: string | null): SavedLayout => ({
  id,
  name: id,
  hotkey,
  host,
  spec: buildPreset("pair"),
  updatedAt: 1,
});

const deep = (n: number): Node => {
  let node: Node = { kind: "pane", id: `leaf`, type: "board" };
  for (let i = 0; i < n; i++)
    node = {
      kind: "split",
      dir: "row",
      ratios: [0.5, 0.5],
      children: [node, { kind: "pane", id: `x${i}`, type: "board" }],
    };
  return node;
};

describe("parseRows drops hostile or corrupt rows (R6.3 security)", () => {
  it("keeps a good row and returns a fresh typed spec", () => {
    const { rows, dropped } = parseRows({ layouts: [wire("a", { hotkey: 3, host: "h1" })] });
    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({ id: "a", hotkey: 3, host: "h1", updatedAt: 5 });
    expect(rows[0]!.spec.id).toBe("pair");
  });

  it("drops over-deep specs", () => {
    const tooDeep: LayoutSpec = { version: 1, id: "d", name: "d", root: deep(MAX_DEPTH + 1) };
    const ok: LayoutSpec = { version: 1, id: "d", name: "d", root: deep(MAX_DEPTH - 1) };
    const { rows, dropped } = parseRows({
      layouts: [wire("deep", {}, tooDeep), wire("fine", {}, ok)],
    });
    expect(rows.map((r) => r.id)).toEqual(["fine"]);
    expect(dropped).toBe(1);
  });

  it.each([
    ["spec not an object", { spec: "x" }],
    ["spec bad version", { spec: { ...buildPreset("pair"), version: 2 } }],
    [
      "ratios not summing to 1",
      { spec: JSON.parse(JSON.stringify(buildPreset("pair")).replace("0.5", "0.9")) },
    ],
    ["hotkey 0", { hotkey: 0 }],
    ["hotkey 10", { hotkey: 10 }],
    ["hotkey string", { hotkey: "1" }],
    ["hotkey fraction", { hotkey: 1.5 }],
    ["empty name", { name: "" }],
    ["name not string", { name: 5 }],
    ["host empty", { host: "" }],
    ["host number", { host: 3 }],
    ["id with slash", { id: "a/b" }],
    ["id too long", { id: "a".repeat(65) }],
    ["id not string", { id: 4 }],
  ])("drops a row with %s", (_n, extra) => {
    expect(parseRow(wire("r", extra))).toBeNull();
  });

  it("drops non-objects, a missing layouts array, duplicate ids and caps the count", () => {
    expect(parseRows(null).rows).toEqual([]);
    expect(parseRows({ layouts: "x" }).rows).toEqual([]);
    const r = parseRows({ layouts: [wire("a"), 7, null, wire("a"), []] });
    expect(r.rows).toHaveLength(1);
    expect(r.dropped).toBe(4);
    const many = parseRows({ layouts: Array.from({ length: 205 }, (_, i) => wire(`m${i}`)) });
    expect(many.rows).toHaveLength(200);
    expect(many.dropped).toBe(5);
  });

  it("accepts ids __proto__ and constructor as plain data without touching any prototype", () => {
    const { rows } = parseRows(
      JSON.parse(
        `{"layouts":[${JSON.stringify(wire("__proto__"))},${JSON.stringify(wire("constructor", { hotkey: 2 }))}]}`,
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>)["name"]).toBeUndefined();
    expect(resolveSlot(rows, null, 2)?.id).toBe("constructor");
  });

  it("a JSON body with __proto__ keys inside the spec does not pollute", () => {
    const evil = JSON.parse(
      `{"layouts":[{"id":"e","name":"e","hotkey":null,"host":null,"updated_at":1,"__proto__":{"polluted":1},"spec":{"version":1,"id":"e","name":"e","__proto__":{"polluted":1},"root":{"kind":"pane","id":"p","type":"board","__proto__":{"polluted":1}}}}]}`,
    );
    const { rows } = parseRows(evil);
    expect(rows).toHaveLength(1);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(rows[0]!.spec.root)).not.toContain("polluted");
  });

  it("a pane with sessionId constructor survives validation (the pane view guards the lookup)", () => {
    const spec = {
      version: 1,
      id: "s",
      name: "s",
      root: { kind: "pane", id: "p", type: "session", sessionId: "constructor" },
    };
    expect(parseRow(wire("s", {}, spec))).not.toBeNull();
  });
});

describe("resolveSlot, the host pin rule (R6.3)", () => {
  const rows = [
    row("all1", 1, null),
    row("pin1", 1, "lap"),
    row("all2", 2, null),
    row("pin3", 3, "lap"),
    row("none", null, null),
  ];
  it("a layout pinned to the host wins over the unpinned one", () => {
    expect(resolveSlot(rows, "lap", 1)?.id).toBe("pin1");
    expect(resolveSlot(rows, "other", 1)?.id).toBe("all1");
    expect(resolveSlot(rows, null, 1)?.id).toBe("all1");
  });
  it("an unpinned layout opens everywhere when nothing shadows it", () => {
    expect(resolveSlot(rows, "lap", 2)?.id).toBe("all2");
  });
  it("a pinned layout does not open on another host or without a host", () => {
    expect(resolveSlot(rows, "other", 3)).toBeNull();
    expect(resolveSlot(rows, null, 3)).toBeNull();
  });
  it("an empty slot gives null, slotless rows are never opened", () => {
    expect(resolveSlot(rows, "lap", 9)).toBeNull();
  });
  it("agrees with the hub's active_hotkey for every host and slot", () => {
    // The hub's rule (packages/hub/src/routes/layouts.ts withActive), restated for the comparison.
    const hubActive = (host: string | undefined) => {
      const pinned = new Set(
        host === undefined
          ? []
          : rows.filter((r) => r.host === host && r.hotkey !== null).map((r) => r.hotkey),
      );
      return rows
        .filter((r) => {
          if (r.hotkey === null) return false;
          if (r.host === null) return !pinned.has(r.hotkey);
          return host !== undefined && r.host === host;
        })
        .map((r) => r.id);
    };
    for (const host of ["lap", "other", undefined]) {
      const mine = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map((n) => resolveSlot(rows, host ?? null, n)?.id)
        .filter(Boolean);
      expect(mine.sort()).toEqual(
        hubActive(host)
          .filter((id) => rows.find((r) => r.id === id)!.host === null || host !== undefined)
          .sort(),
      );
    }
  });
});

describe("withPut moves a slot within its host scope only", () => {
  it("clears the previous holder in the same scope, not in another", () => {
    const rows = [row("a", 1, null), row("b", 1, "lap")];
    const out = withPut(rows, row("c", 1, null));
    expect(out.map((r) => [r.id, r.hotkey])).toEqual([
      ["c", 1],
      ["a", null],
      ["b", 1],
    ]);
  });
  it("replaces a row with the same id", () => {
    expect(withPut([row("a", 1, null)], row("a", 2, null)).map((r) => r.hotkey)).toEqual([2]);
  });
});

describe("viewerHost", () => {
  it("is the host of the most recently active session, null when empty", () => {
    expect(viewerHost({})).toBeNull();
    expect(
      viewerHost({ a: { host: "x", last_event_at: 1 }, b: { host: "y", last_event_at: 9 } }),
    ).toBe("y");
  });
});

describe("hub adapter and errors", () => {
  const res = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });
  it("sends the bearer and never puts the token in the URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(res(200, { layouts: [] }));
    }) as unknown as typeof fetch;
    await hubAdapter("http://hub:8787", "sekret", f).list();
    expect(calls[0]!.url).toBe("http://hub:8787/layouts");
    expect(calls[0]!.url).not.toContain("sekret");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sekret",
    );
  });
  it("encodes the id in the path, even a hostile one", async () => {
    let url = "";
    const f = ((u: string) => ((url = u), Promise.resolve(res(204)))) as unknown as typeof fetch;
    await hubAdapter("", "t", f).remove("a/../b");
    expect(url).toBe("/layouts/a%2F..%2Fb");
  });
  it.each([
    [401, undefined, /Hub rejected the token/],
    [429, undefined, /Too many layout changes/],
    [409, { error: "layout_limit" }, /limit of 200/],
    [409, { error: "slot_reserved" }, /reserved by a builtin/],
    [400, { error: "invalid_body", reason: "spec" }, /refused the layout \(spec\)/],
    [500, undefined, /answered 500/],
  ])("status %i becomes a user message", async (status, body, msg) => {
    const f = (() => Promise.resolve(res(status, body))) as unknown as typeof fetch;
    const err = await hubAdapter("", "t", f)
      .list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(describeError(err, "x")).toMatch(msg);
  });
  it("a network failure says the hub is unreachable", () => {
    expect(describeError(new TypeError("fetch failed"), "loading")).toMatch(/Cannot reach the hub/);
  });
  it("httpBase maps ws to http and rejects other schemes", () => {
    expect(httpBase("")).toBe("");
    expect(httpBase("ws://h:1/")).toBe("http://h:1");
    expect(httpBase("wss://h/p/")).toBe("https://h/p");
    expect(httpBase("ftp://h")).toBeNull();
    expect(httpBase("nonsense")).toBeNull();
  });
});

describe("memory adapter has the hub's semantics", () => {
  it("round trips and moves a slot", async () => {
    const m = memoryAdapter();
    const spec = buildPreset("quad");
    await m.put("a", { name: "A", hotkey: 1, host: null, spec });
    await m.put("b", { name: "B", hotkey: 1, host: null, spec });
    const { rows } = parseRows(await m.list());
    expect(rows.map((r) => [r.id, r.hotkey]).sort()).toEqual([
      ["a", null],
      ["b", 1],
    ]);
    await m.remove("a");
    expect(parseRows(await m.list()).rows).toHaveLength(1);
    await expect(m.remove("zzz")).rejects.toBeInstanceOf(HubError);
  });
});
