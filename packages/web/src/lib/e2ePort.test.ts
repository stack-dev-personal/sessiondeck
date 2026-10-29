// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolvePort } from "../../e2e/port";

describe("resolvePort (SD_E2E_PORT)", () => {
  it("falls back when unset or empty", () => {
    expect(resolvePort(undefined, 5173)).toBe(5173);
    expect(resolvePort("", 5173)).toBe(5173);
    expect(resolvePort("  ", 5174)).toBe(5174);
  });

  it("accepts a valid port", () => {
    expect(resolvePort("25197", 5173)).toBe(25197);
    expect(resolvePort("65535", 5173)).toBe(65535);
  });

  it("rejects non-integers and out-of-range values", () => {
    for (const bad of ["0", "-1", "65536", "abc", "80.5", "1e3x"]) {
      expect(() => resolvePort(bad, 5173)).toThrow(/SD_E2E_PORT/);
    }
  });
});
