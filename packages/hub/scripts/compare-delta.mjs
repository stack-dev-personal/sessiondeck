// Pure helpers for ccusage-compare.mjs (unit-tested; no I/O).
//
// ccusage prices every cache write at the 5-minute rate. The hub (decision 25) prices 1-hour writes
// at the 1-hour rate, so hub cost may exceed ccusage by exactly sum(1h tokens) x (1h rate - 5m
// rate). The harness gets that expected delta by pricing the same transcripts twice in the hub
// (split on and off) and subtracting.

/** Percent difference of h from c (Infinity when c is 0 and they differ). */
export const pct = (h, c) =>
  h === c ? 0 : c === 0 ? Infinity : (Math.abs(h - c) / Math.abs(c)) * 100;

/** Hub-measured 1-hour delta for one row: split-priced cost minus legacy (5-minute-only) cost. */
export const expectedDelta = (splitCost, legacyCost) => splitCost - legacyCost;

/**
 * Judges one cost row. `delta` is the hub's split minus legacy cost; `independent` is the same
 * quantity computed from the transcripts (sum of 1h tokens x (1h rate - 5m rate)), so a pricing bug
 * that lands in the delta is caught: the row fails when the two disagree by more than 1e-9
 * relative, or when the delta is negative. The legacy cost (hub - delta) must be within
 * `tolerancePct` of ccusage; `exact` reports whether hub - ccusage - delta is within 1e-9 relative.
 */
export function judgeCost({ hub, cc, delta, independent, tolerancePct }) {
  const residual = hub - cc - delta;
  const scale = Math.max(Math.abs(hub), Math.abs(cc), Number.MIN_VALUE);
  const dscale = Math.max(Math.abs(delta), Math.abs(independent), 1e-12);
  const deltaOk = delta >= -1e-12 && Math.abs(delta - independent) <= 1e-9 * dscale;
  return {
    residual,
    exact: Math.abs(residual) <= 1e-9 * scale,
    deltaOk,
    ok: deltaOk && pct(hub - delta, cc) <= tolerancePct,
  };
}
