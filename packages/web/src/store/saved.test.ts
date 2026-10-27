// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { HubError, memoryAdapter, type SavedAdapter } from "../layout/saved";
import { buildPreset } from "../layout/presets";
import { STORAGE_KEYS } from "../lib/storage";
import { createBoardStore } from "./board";
import { DEFAULT_SETTINGS, type Settings } from "./ui";
import { useLayout } from "./layout";
import { loadCachedRows, startSaved, useSaved } from "./saved";

const wire = (id: string, extra: Record<string, unknown> = {}, preset = "pair" as const) => ({
  id,
  name: `Name ${id}`,
  hotkey: null,
  host: null,
  spec: { ...buildPreset(preset), id },
  updated_at: 1,
  active_hotkey: false,
  ...extra,
});

function fake(over: Partial<SavedAdapter> = {}): SavedAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: () => (calls.push("list"), Promise.resolve({ layouts: [] })),
    put: (id, b) => (calls.push(`put ${id}`), Promise.resolve({ id, ...b, updated_at: 2 })),
    remove: (id) => (calls.push(`remove ${id}`), Promise.resolve()),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useSaved.setState({ rows: [], status: "idle", notice: null });
  useLayout.setState({ spec: buildPreset("solo"), snapshot: null });
});

describe("load", () => {
  it("validates, drops hostile rows, says how many, and caches the survivors", async () => {
    const tooDeep = { version: 1, id: "d", name: "d", root: buildPreset("quad").root };
    let deepRoot: unknown = { kind: "pane", id: "leaf", type: "board" };
    for (let i = 0; i < 9; i++)
      deepRoot = {
        kind: "split",
        dir: "row",
        ratios: [0.5, 0.5],
        children: [deepRoot, { kind: "pane", id: `x${i}`, type: "board" }],
      };
    useSaved.getState().setAdapter(
      fake({
        list: () =>
          Promise.resolve({
            layouts: [
              wire("good", { hotkey: 1 }),
              wire("__proto__", { hotkey: 2 }),
              wire("constructor"),
              wire("deep", {}, undefined),
              { ...wire("deep2"), spec: { ...tooDeep, root: deepRoot } },
              wire("bad slot", { hotkey: 4 }),
              { nonsense: true },
            ],
          }),
      }),
    );
    await useSaved.getState().load();
    const s = useSaved.getState();
    expect(s.rows.map((r) => r.id)).toEqual(["good", "__proto__", "constructor", "deep"]);
    expect(s.status).toBe("ready");
    expect(s.notice).toMatchObject({ tone: "error" });
    expect(s.notice!.text).toMatch(/Ignored 3 saved layouts/);
    expect(loadCachedRows().map((r) => r.id)).toEqual(["good", "__proto__", "constructor", "deep"]);
  });

  it("a failed load keeps the cached rows, goes offline and names the cause", async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.savedLayouts,
      JSON.stringify({ layouts: [wire("c1", { hotkey: 5 })] }),
    );
    useSaved.setState({ rows: loadCachedRows() });
    useSaved.getState().setAdapter(fake({ list: () => Promise.reject(new HubError(401)) }));
    await useSaved.getState().load();
    expect(useSaved.getState().rows.map((r) => r.id)).toEqual(["c1"]);
    expect(useSaved.getState().status).toBe("offline");
    expect(useSaved.getState().notice!.text).toMatch(/rejected the token/);
  });

  it("a corrupt or hostile cache is validated like a hub body", () => {
    window.localStorage.setItem(STORAGE_KEYS.savedLayouts, "{nope");
    expect(loadCachedRows()).toEqual([]);
    window.localStorage.setItem(
      STORAGE_KEYS.savedLayouts,
      JSON.stringify({ layouts: [wire("ok"), { id: "x" }] }),
    );
    expect(loadCachedRows().map((r) => r.id)).toEqual(["ok"]);
  });

  it("only the newest of two overlapping loads wins", async () => {
    let first!: (v: unknown) => void;
    const a = fake({ list: () => new Promise((r) => (first = r)) });
    useSaved.getState().setAdapter(a);
    const p1 = useSaved.getState().load();
    useSaved
      .getState()
      .setAdapter(fake({ list: () => Promise.resolve({ layouts: [wire("new")] }) }));
    await useSaved.getState().load();
    first({ layouts: [wire("old")] });
    await p1;
    expect(useSaved.getState().rows.map((r) => r.id)).toEqual(["new"]);
  });
});

describe("hotkeys switch from the cache without the network (R6.3)", () => {
  it("press applies the cached spec synchronously and names the layout", () => {
    const calls = vi.fn();
    useSaved.getState().setAdapter(fake({ list: calls, put: calls, remove: calls }));
    useSaved.setState({
      rows: [
        {
          id: "a",
          name: "Alpha",
          hotkey: 1,
          host: null,
          spec: { ...buildPreset("quad"), id: "a" },
          updatedAt: 1,
        },
      ],
    });
    const t0 = performance.now();
    const r = useSaved.getState().press(1, "h");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(r?.id).toBe("a");
    expect(useLayout.getState().spec.id).toBe("a");
    expect(useSaved.getState().notice?.text).toBe("Layout 1: Alpha");
    expect(calls).not.toHaveBeenCalled();
  });

  it("pin rule on press: the pinned layout wins on its host only", () => {
    const spec = (id: string) => ({ ...buildPreset("pair"), id });
    useSaved.setState({
      rows: [
        { id: "all", name: "All", hotkey: 3, host: null, spec: spec("all"), updatedAt: 1 },
        { id: "pin", name: "Pin", hotkey: 3, host: "lap", spec: spec("pin"), updatedAt: 1 },
      ],
    });
    useSaved.getState().press(3, "lap");
    expect(useLayout.getState().spec.id).toBe("pin");
    useSaved.getState().press(3, "box");
    expect(useLayout.getState().spec.id).toBe("all");
  });

  it("an empty slot changes nothing and says so", () => {
    useSaved.getState().press(7, null);
    expect(useLayout.getState().spec.id).toBe("solo");
    expect(useSaved.getState().notice?.text).toBe("No layout in slot 7.");
  });

  it("switching to a saved layout drops the compact-all snapshot", () => {
    useLayout.getState().toggleCompactAll();
    expect(useLayout.getState().snapshot).not.toBeNull();
    useSaved.setState({
      rows: [
        {
          id: "a",
          name: "A",
          hotkey: 1,
          host: null,
          spec: { ...buildPreset("pair"), id: "a" },
          updatedAt: 1,
        },
      ],
    });
    useSaved.getState().press(1, null);
    expect(useLayout.getState().snapshot).toBeNull();
  });
});

describe("save, update, delete", () => {
  it("save PUTs the current layout under a hub-legal id and caches it", async () => {
    const a = fake();
    useSaved.getState().setAdapter(a);
    useLayout.getState().applyPreset("quad");
    const err = await useSaved.getState().save({ name: "Quad A", hotkey: 2, host: "lap" });
    expect(err).toBeNull();
    const row = useSaved.getState().rows[0]!;
    expect(row).toMatchObject({ name: "Quad A", hotkey: 2, host: "lap" });
    expect(row.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(row.spec.id).toBe(row.id);
    expect(row.spec.name).toBe("Quad A");
    expect(loadCachedRows()[0]!.id).toBe(row.id);
    expect(useSaved.getState().notice?.text).toBe('Saved "Quad A" in slot 2.');
  });

  it("saving to a taken slot moves it in the same scope only", async () => {
    useSaved.getState().setAdapter(memoryAdapter());
    await useSaved.getState().save({ name: "One", hotkey: 1, host: null });
    await useSaved.getState().save({ name: "Pinned", hotkey: 1, host: "lap" });
    await useSaved.getState().save({ name: "Two", hotkey: 1, host: null });
    const by = Object.fromEntries(useSaved.getState().rows.map((r) => [r.name, r.hotkey]));
    expect(by).toEqual({ One: null, Pinned: 1, Two: 1 });
  });

  it("rename and reassign slot PUT the stored spec back with the new name", async () => {
    const a = fake();
    useSaved.getState().setAdapter(a);
    useSaved.setState({
      rows: [
        {
          id: "a",
          name: "Old",
          hotkey: null,
          host: null,
          spec: { ...buildPreset("pair"), id: "a", name: "Old" },
          updatedAt: 1,
        },
      ],
    });
    expect(await useSaved.getState().update("a", { name: "New" })).toBeNull();
    expect(useSaved.getState().rows[0]).toMatchObject({ name: "New" });
    expect(useSaved.getState().rows[0]!.spec.name).toBe("New");
    expect(await useSaved.getState().update("a", { hotkey: 4 })).toBeNull();
    expect(useSaved.getState().rows[0]!.hotkey).toBe(4);
    expect(a.calls).toEqual(["put a", "put a"]);
  });

  it("delete removes the row from state and cache", async () => {
    const a = fake();
    useSaved.getState().setAdapter(a);
    useSaved.setState({
      rows: [
        { id: "a", name: "A", hotkey: 1, host: null, spec: buildPreset("pair"), updatedAt: 1 },
      ],
    });
    expect(await useSaved.getState().remove("a")).toBeNull();
    expect(useSaved.getState().rows).toEqual([]);
    expect(loadCachedRows()).toEqual([]);
    expect(a.calls).toEqual(["remove a"]);
  });

  it.each([
    [new HubError(401), /Hub rejected the token/],
    [new HubError(429), /Too many layout changes/],
    [new HubError(409, "layout_limit"), /limit of 200/],
    [new HubError(409, "slot_reserved"), /reserved by a builtin/],
    [new HubError(400, "invalid_body", "spec"), /refused the layout/],
  ])(
    "%s on save is returned to the dialog, shown as a notice, and nothing is stored",
    async (e, msg) => {
      useSaved.getState().setAdapter(fake({ put: () => Promise.reject(e) }));
      const err = await useSaved.getState().save({ name: "X", hotkey: 1, host: null });
      expect(err).toMatch(msg);
      expect(useSaved.getState().notice).toMatchObject({ tone: "error", text: err });
      expect(useSaved.getState().rows).toEqual([]);
    },
  );

  it("a failed delete keeps the row", async () => {
    useSaved.getState().setAdapter(fake({ remove: () => Promise.reject(new HubError(429)) }));
    useSaved.setState({
      rows: [
        { id: "a", name: "A", hotkey: null, host: null, spec: buildPreset("pair"), updatedAt: 1 },
      ],
    });
    expect(await useSaved.getState().remove("a")).toMatch(/Too many/);
    expect(useSaved.getState().rows).toHaveLength(1);
  });

  it("a hub reply that is not a valid layout is an error, not a stored row", async () => {
    useSaved.getState().setAdapter(fake({ put: () => Promise.resolve({ id: "x" }) }));
    expect(await useSaved.getState().save({ name: "X", hotkey: null, host: null })).not.toBeNull();
    expect(useSaved.getState().rows).toEqual([]);
  });
});

describe("startSaved wiring", () => {
  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
  it("loads at start, again when the stream opens, and when URL or token change", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ layouts: [] }))));
    const board = createBoardStore();
    const ui = create<{ settings: Settings }>()(() => ({
      settings: settings({ hubUrl: "http://hub:1", token: "t" }),
    }));
    const stop = startSaved(board, ui, useSaved, fetchFn as unknown as typeof fetch);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    board.getState().setConnection("connecting");
    board.getState().setConnection("open");
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    board.getState().setConnection("open");
    ui.setState({ settings: settings({ hubUrl: "http://hub:1", token: "t2" }) });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    stop();
    ui.setState({ settings: settings({ hubUrl: "http://hub:1", token: "t3" }) });
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
