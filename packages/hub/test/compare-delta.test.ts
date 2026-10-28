// R2.10: expected-delta logic of scripts/ccusage-compare.mjs (decision 25).
import { describe, expect, it } from "vitest";
import { expectedDelta, judgeCost, pct } from "../scripts/compare-delta.mjs";

describe("ccusage-compare expected delta", () => {
  it("delta is split cost minus 5m-only cost", () => {
    // 1M 1h tokens on opus-5-5: 8 - 5 = 3 USD.
    expect(expectedDelta(10, 7)).toBe(3);
  });
  it("passes when hub - ccusage equals the delta exactly", () => {
    const j = judgeCost({ hub: 10.5, cc: 7.5, delta: 3, tolerancePct: 1 });
    expect(j).toMatchObject({ ok: true, exact: true, residual: 0 });
  });
  it("passes within the tolerance for the remainder but is not exact", () => {
    const j = judgeCost({ hub: 10.52, cc: 7.5, delta: 3, tolerancePct: 1 });
    expect(j.ok).toBe(true);
    expect(j.exact).toBe(false);
  });
  it("fails when the difference is not explained by the delta", () => {
    expect(judgeCost({ hub: 10.5, cc: 7.5, delta: 0, tolerancePct: 1 }).ok).toBe(false);
    expect(judgeCost({ hub: 10.5, cc: 7.5, delta: 1, tolerancePct: 1 }).ok).toBe(false);
  });
  it("pct handles zero", () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(1, 0)).toBe(Infinity);
  });
});
