// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import * as cb from "../../scripts/check-bundle.mjs";

describe("check-bundle problems()", () => {
  it("nomock passes on clean text", () => {
    expect(cb.problems("var a=1;", "nomock")).toEqual([]);
  });
  it("nomock fails when the fixture marker leaks", () => {
    expect(cb.problems(`x="${cb.MARKER}"`, "nomock")).toHaveLength(1);
  });
  it("nomock fails when window.__sd is injected", () => {
    expect(cb.problems("window.__sd={board:1}", "nomock")).toEqual([
      "__sd test hook present in nomock bundle",
    ]);
  });
  it("nomock fails when the atlas mock leaks", () => {
    expect(cb.problems(`x="${cb.ATLAS_MOCK}"`, "nomock")).toEqual([
      "atlas mock marker present in nomock bundle",
    ]);
  });
  it("mock requires the marker", () => {
    expect(cb.problems("var a=1;", "mock")).toHaveLength(1);
    expect(cb.problems(cb.MARKER, "mock")).toEqual([]);
  });
});
