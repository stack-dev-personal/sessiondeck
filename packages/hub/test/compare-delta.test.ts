// R2.10: expected-delta logic of scripts/ccusage-compare.mjs (decision 25).
import { describe, expect, it } from "vitest";
import { expectedDelta, judgeCost, pct } from "../scripts/compare-delta.mjs";

describe("ccusage-compare expected delta", () => {
  it("delta is split cost minus 5m-only cost", () => {
    // 1M 1h tokens on opus-5-5: 8 - 5 = 3 USD.
    expect(expectedDelta(10, 7)).toBe(3);
  });
  it("passes when hub - ccusage equals the delta exactly", () => {
    const j = judgeCost({ hub: 10.5, cc: 7.5, delta: 3, independent: 3, tolerancePct: 1 });
    expect(j).toMatchObject({ ok: true, exact: true, residual: 0 });
  });
  it("passes within the tolerance for the remainder but is not exact", () => {
    const j = judgeCost({ hub: 10.52, cc: 7.5, delta: 3, independent: 3, tolerancePct: 1 });
    expect(j.ok).toBe(true);
    expect(j.exact).toBe(false);
  });
  it("fails when the difference is not explained by the delta", () => {
    expect(judgeCost({ hub: 10.5, cc: 7.5, delta: 0, independent: 0, tolerancePct: 1 }).ok).toBe(
      false,
    );
    expect(judgeCost({ hub: 10.5, cc: 7.5, delta: 1, independent: 1, tolerancePct: 1 }).ok).toBe(
      false,
    );
  });
  it("fails when the hub delta disagrees with the independent delta or is negative", () => {
    expect(
      judgeCost({ hub: 10.5, cc: 7.5, delta: 3, independent: 2, tolerancePct: 1 }).deltaOk,
    ).toBe(false);
    expect(
      judgeCost({ hub: 7, cc: 7.5, delta: -0.5, independent: -0.5, tolerancePct: 10 }).ok,
    ).toBe(false);
  });
  it("pct handles zero", () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(1, 0)).toBe(Infinity);
  });
});

// R2.10 review fix: the harness delta must equal the hub's split-minus-legacy cost.
import { costFromPricing, ModelPricingSchema } from "../src/pricing/pricing.ts";
import { oneHourDelta } from "../scripts/compare-hub.ts";

function hubDelta(
  p: ReturnType<typeof ModelPricingSchema.parse>,
  cc: number,
  h: number,
  f: number,
) {
  const t = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: cc,
    cache_creation_1h_tokens: h,
    cache_creation_5m_tokens: f,
  };
  return costFromPricing(t, p, true) - costFromPricing(t, p, false);
}

describe("oneHourDelta agrees with the hub", () => {
  const sonnet = ModelPricingSchema.parse({
    input_cost_per_token: 3e-6,
    input_cost_per_token_above_200k_tokens: 6e-6,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
    cache_creation_input_token_cost_above_1hr_above_200k_tokens: 12e-6,
  });
  it("(i) h = 400k, f = 0 splits at 200k: 1.35 USD", () => {
    expect(oneHourDelta(sonnet, 400_000, 400_000, 0)).toBeCloseTo(1.35, 9);
    expect(hubDelta(sonnet, 400_000, 400_000, 0)).toBeCloseTo(1.35, 9);
  });
  it("(ii) no above-200k fields, 300k write: h x (r1 - r5)", () => {
    const p = ModelPricingSchema.parse({
      input_cost_per_token: 3e-6,
      cache_creation_input_token_cost: 3.75e-6,
      cache_creation_input_token_cost_above_1hr: 6e-6,
    });
    expect(oneHourDelta(p, 300_000, 300_000, 0)).toBeCloseTo(300_000 * 2.25e-6, 9);
    expect(hubDelta(p, 300_000, 300_000, 0)).toBeCloseTo(oneHourDelta(p, 300_000, 300_000, 0), 9);
  });
  it("(iii) no input rate and no 1-hour field: delta 0", () => {
    const p = ModelPricingSchema.parse({ cache_creation_input_token_cost: 3.75e-6 });
    expect(oneHourDelta(p, 1000, 1000, 0)).toBe(0);
    expect(hubDelta(p, 1000, 1000, 0)).toBe(0);
  });
  it("mixed h and f across the threshold", () => {
    const d = oneHourDelta(sonnet, 500_000, 100_000, 400_000);
    expect(d).toBeCloseTo(hubDelta(sonnet, 500_000, 100_000, 400_000), 9);
  });
});
