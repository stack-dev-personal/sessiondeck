import { formatCost } from "../lib/format";

/** "12.4 h", "0.5 h"; n/a for a missing or non-finite value. */
export function formatHours(h: number | null | undefined): string {
  return typeof h === "number" && Number.isFinite(h) ? `${h.toFixed(1)} h` : "n/a";
}

/** History cost as dollars, two decimals, thousands separated; n/a when unknown. */
export function formatTotalCost(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "n/a";
  return usd >= 1000
    ? `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : formatCost(usd);
}

export function formatCount(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "n/a";
}
