// Pure helpers for ccusage-compare.mjs (unit-tested; no I/O).
//
// ccusage prices every cache write at the 5-minute rate. The hub (decision 25) prices 1-hour writes
// at the 1-hour rate, so hub cost may exceed ccusage by exactly sum(1h tokens) x (1h rate - 5m
// rate). The harness gets that expected delta by pricing the same transcripts twice in the hub
// (split on and off) and subtracting.

/** Percent difference of h from c (Infinity when c is 0 and they differ). */
export const pct = (h, c) =>
  h === c ? 0 : c === 0 ? Infinity : (Math.abs(h - c) / Math.abs(c)) * 100;

/** Expected hub-minus-ccusage cost for one row: split-priced cost minus legacy-priced cost. */
export const expectedDelta = (splitCost, legacyCost) => splitCost - legacyCost;

/**
 * Judges one cost row. `residual` is hub - ccusage - expected delta. The row passes when the cost
 * after removing the expected 1-hour delta is within `tolerancePct` of ccusage; `exact` reports
 * whether the residual is also within 1e-9 relative.
 */
export function judgeCost({ hub, cc, delta, tolerancePct }) {
  const residual = hub - cc - delta;
  const scale = Math.max(Math.abs(hub), Math.abs(cc), Number.MIN_VALUE);
  return {
    residual,
    exact: Math.abs(residual) <= 1e-9 * scale,
    ok: pct(hub - delta, cc) <= tolerancePct,
  };
}
