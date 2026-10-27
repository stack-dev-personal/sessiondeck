// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildPreset } from "../layout/presets";
import { serialize } from "../layout/spec";
import { STORAGE_KEYS } from "../lib/storage";
import { loadLayout, useLayout } from "./layout";

beforeEach(() => {
  window.localStorage.clear();
  useLayout.setState({ spec: buildPreset("solo") });
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
