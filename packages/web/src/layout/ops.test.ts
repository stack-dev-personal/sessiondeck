import { describe, expect, it } from "vitest";
import { setPaneCompact, setRatiosAt } from "./ops";
import { buildPreset } from "./presets";
import { panesOf } from "./spec";

describe("layout ops", () => {
  it("setRatiosAt replaces only the addressed split and leaves the input untouched", () => {
    const spec = buildPreset("quad");
    const before = JSON.stringify(spec);
    const next = setRatiosAt(spec, [1], [0.3, 0.7]);
    expect(JSON.stringify(spec)).toBe(before);
    const root = next.root;
    expect(root.kind === "split" && root.children[1]).toMatchObject({ ratios: [0.3, 0.7] });
    expect(root.kind === "split" && root.children[0]).toMatchObject({ ratios: [0.5, 0.5] });
  });
  it("ignores a path that is missing or has the wrong arity", () => {
    const spec = buildPreset("quad");
    expect(setRatiosAt(spec, [5], [0.5, 0.5])).toBe(spec);
    expect(setRatiosAt(spec, [], [0.2, 0.3, 0.5])).toBe(spec);
  });
  it("setPaneCompact toggles one pane and is a no-op when unchanged", () => {
    const spec = buildPreset("pair");
    const next = setPaneCompact(spec, "p0", true);
    expect(panesOf(next).map((p) => p.compact)).toEqual([true, undefined]);
    expect(setPaneCompact(next, "p0", true)).toBe(next);
    expect(panesOf(setPaneCompact(next, "p0", false))[0]).toEqual(panesOf(spec)[0]);
  });
});
