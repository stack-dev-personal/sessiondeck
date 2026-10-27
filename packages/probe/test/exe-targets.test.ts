import { describe, expect, it } from "vitest";
import { selectTargets } from "../scripts/exe-targets.mjs";

const dirs = (p: string, hostOnly = false) =>
  selectTargets(p, { hostOnly }).targets.map((t) => `${t.dir}${t.cross ? ":cross" : ""}`);

describe("selectTargets", () => {
  it("win32 builds windows native and linux cross, with the floor", () => {
    expect(dirs("win32")).toEqual(["windows-x64", "linux-x64:cross"]);
    expect(selectTargets("win32").includeFloor).toBe(true);
  });
  it("win32 --host-only builds windows only, no floor", () => {
    expect(dirs("win32", true)).toEqual(["windows-x64"]);
    expect(selectTargets("win32", { hostOnly: true }).includeFloor).toBe(false);
  });
  it("linux builds linux native only and prints a skip notice", () => {
    const r = selectTargets("linux");
    expect(dirs("linux")).toEqual(["linux-x64"]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("skipping windows-x64");
    expect(r.includeFloor).toBe(true);
  });
  it("linux --host-only is the same target without the floor", () => {
    expect(dirs("linux", true)).toEqual(["linux-x64"]);
    expect(selectTargets("linux", { hostOnly: true }).includeFloor).toBe(false);
  });
  it("never marks a native target as cross", () => {
    for (const p of ["win32", "linux"]) {
      const native = selectTargets(p).targets.filter((t) => !t.cross);
      expect(native).toHaveLength(1);
    }
  });
  it("rejects unsupported hosts", () => {
    expect(() => selectTargets("darwin")).toThrow(/unsupported/);
  });
});
