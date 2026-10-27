// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPreset } from "../layout/presets";
import { panesOf, serialize, type LayoutSpec } from "../layout/spec";
import { STORAGE_KEYS } from "../lib/storage";
import { loadLayout, useLayout } from "./layout";

beforeEach(() => {
  window.localStorage.clear();
  useLayout.setState({ spec: buildPreset("solo"), snapshot: null });
});

describe("layout store persistence (R6.1)", () => {
  it("a fresh viewer gets solo", () => {
    expect(loadLayout().id).toBe("solo");
  });

  it("applyPreset persists and a reload reads the same spec back", () => {
    useLayout.getState().applyPreset("by-project", ["a", "b"]);
    const live = useLayout.getState().spec;
    expect(window.localStorage.getItem(STORAGE_KEYS.layout)).toBe(serialize(live));
    expect(loadLayout()).toEqual(live);
  });

  it("resized ratios survive a reload exactly", () => {
    useLayout.getState().applyPreset("quad");
    useLayout.getState().setRatios([0], [0.1234567, 1 - 0.1234567]);
    expect(loadLayout()).toEqual(useLayout.getState().spec);
  });

  it("a corrupt stored layout falls back to solo", () => {
    window.localStorage.setItem(STORAGE_KEYS.layout, '{"version":1,"id":"x"');
    expect(loadLayout().id).toBe("solo");
    window.localStorage.setItem(
      STORAGE_KEYS.layout,
      serialize(buildPreset("pair")).replace("0.5", "0.9"),
    );
    expect(loadLayout().id).toBe("solo");
  });

  it("works when storage throws", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("full");
    };
    try {
      useLayout.getState().applyPreset("grid6");
      expect(useLayout.getState().spec.id).toBe("grid6");
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it("toggles a pane compact flag through the reducer", () => {
    useLayout.getState().applyPreset("pair");
    useLayout.getState().setPaneCompact("p1", true);
    expect(loadLayout()).toEqual(useLayout.getState().spec);
    expect(JSON.stringify(loadLayout())).toContain('"compact":true');
  });

  it("never persists or applies an invalid spec", () => {
    const before = useLayout.getState().spec;
    const dup = buildPreset("pair");
    if (dup.root.kind !== "split") throw new Error("pair is a split");
    const bad = {
      ...dup,
      root: { ...dup.root, children: [dup.root.children[0]!, dup.root.children[0]!] },
    };
    window.localStorage.clear();
    useLayout.getState().setSpec(bad);
    useLayout.getState().setRatios([], [0, 1]);
    expect(useLayout.getState().spec).toBe(before);
    expect(window.localStorage.getItem(STORAGE_KEYS.layout)).toBeNull();
  });

  it("rescales drag ratios that drift from an exact sum so they still reload", () => {
    useLayout.getState().applyPreset("pair");
    useLayout.getState().setRatios([], [30.004, 70.004]);
    expect(loadLayout()).toEqual(useLayout.getState().spec);
    const root = useLayout.getState().spec.root;
    expect(root.kind === "split" ? root.ratios[0] : -1).toBeCloseTo(0.3, 3);
  });
});

describe("Shift+C compact all (R6.5)", () => {
  /** quad with odd ratios in all three splits and one pane compacted by hand. */
  function messyQuad(): LayoutSpec {
    const st = useLayout.getState();
    st.applyPreset("quad");
    st.setRatios([], [0.3125, 0.6875]);
    st.setRatios([0], [0.2, 0.8]);
    st.setRatios([1], [0.9, 0.1]);
    st.setPaneCompact(panesOf(useLayout.getState().spec)[2]!.id, true);
    return useLayout.getState().spec;
  }
  const compactFlags = () => panesOf(useLayout.getState().spec).map((p) => p.compact === true);

  it("compacts every pane, then restores the previous spec exactly (deep-equal)", () => {
    const before = messyQuad();
    const frozen = structuredClone(before);
    useLayout.getState().toggleCompactAll();
    expect(compactFlags()).toEqual([true, true, true, true]);
    expect(useLayout.getState().snapshot).toEqual(frozen);
    useLayout.getState().toggleCompactAll();
    expect(useLayout.getState().spec).toEqual(frozen);
    expect(compactFlags()).toEqual([false, false, true, false]);
    expect(useLayout.getState().snapshot).toBeNull();
  });

  it("compacting changes nothing but the compact flags", () => {
    const before = messyQuad();
    useLayout.getState().toggleCompactAll();
    const after = useLayout.getState().spec;
    const strip = (s: LayoutSpec) =>
      JSON.stringify(s, (k, v: unknown) => (k === "compact" ? undefined : v));
    expect(strip(after)).toBe(strip(before));
  });

  it("the snapshot survives a reload, and restoring after it is still exact", async () => {
    const before = structuredClone(messyQuad());
    useLayout.getState().toggleCompactAll();
    const compacted = structuredClone(useLayout.getState().spec);
    vi.resetModules();
    const fresh = (await import("./layout")).useLayout; // a reload: state from storage only
    expect(fresh.getState().spec).toEqual(compacted);
    expect(fresh.getState().snapshot).toEqual(before);
    fresh.getState().toggleCompactAll();
    expect(fresh.getState().spec).toEqual(before);
    expect(window.localStorage.getItem(STORAGE_KEYS.layoutSnapshot)).toBeNull();
    expect(loadLayout()).toEqual(before);
  });

  it("a manual expand of one pane while compacted keeps the snapshot; Shift+C still restores exactly", () => {
    const before = structuredClone(messyQuad());
    useLayout.getState().toggleCompactAll();
    useLayout.getState().setPaneCompact(panesOf(useLayout.getState().spec)[0]!.id, false);
    expect(compactFlags()).toEqual([false, true, true, true]);
    expect(useLayout.getState().snapshot).toEqual(before);
    useLayout.getState().toggleCompactAll();
    expect(useLayout.getState().spec).toEqual(before);
  });

  it("a resize while compacted keeps the snapshot and the restore discards the resize", () => {
    const before = structuredClone(messyQuad());
    useLayout.getState().toggleCompactAll();
    useLayout.getState().setRatios([], [0.5, 0.5]);
    expect(useLayout.getState().snapshot).toEqual(before);
    useLayout.getState().toggleCompactAll();
    expect(useLayout.getState().spec).toEqual(before);
  });

  it("switching layout (preset or saved spec) drops the snapshot", () => {
    messyQuad();
    useLayout.getState().toggleCompactAll();
    useLayout.getState().applyPreset("pair");
    expect(useLayout.getState().snapshot).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.layoutSnapshot)).toBeNull();
    // Shift+C now compacts the new layout and restores it, not the old quad.
    useLayout.getState().toggleCompactAll();
    useLayout.getState().setSpec(buildPreset("focus"));
    expect(useLayout.getState().snapshot).toBeNull();
    expect(compactFlags().some(Boolean)).toBe(false);
  });

  it("a stored snapshot of another layout is ignored on load", async () => {
    window.localStorage.setItem(STORAGE_KEYS.layout, serialize(buildPreset("pair")));
    window.localStorage.setItem(STORAGE_KEYS.layoutSnapshot, serialize(buildPreset("quad")));
    vi.resetModules();
    const fresh = (await import("./layout")).useLayout;
    expect(fresh.getState().spec.id).toBe("pair");
    expect(fresh.getState().snapshot).toBeNull();
  });

  it("with every pane already compact, Shift+C twice is still a no-op overall", () => {
    useLayout.getState().applyPreset("pair");
    for (const p of panesOf(useLayout.getState().spec))
      useLayout.getState().setPaneCompact(p.id, true);
    const before = structuredClone(useLayout.getState().spec);
    useLayout.getState().toggleCompactAll();
    expect(useLayout.getState().snapshot).toEqual(before);
    useLayout.getState().toggleCompactAll();
    expect(useLayout.getState().spec).toEqual(before);
  });
});
