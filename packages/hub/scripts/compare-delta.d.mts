export function pct(h: number, c: number): number;
export function expectedDelta(splitCost: number, legacyCost: number): number;
export function judgeCost(a: { hub: number; cc: number; delta: number; tolerancePct: number }): {
  residual: number;
  exact: boolean;
  ok: boolean;
};
