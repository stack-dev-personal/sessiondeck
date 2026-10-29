/** Pure formatting and threshold helpers for cards (design system section 4). */

export type Level = "ok" | "warn" | "high";
export type MeterKind = "context" | "five_hour" | "seven_day";

/** Upper edges per meter: value <= warn-start is ok below `warn`, high above `high`. */
const THRESHOLDS: Record<MeterKind, { warn: number; high: number }> = {
  context: { warn: 60, high: 80 },
  five_hour: { warn: 60, high: 85 },
  seven_day: { warn: 60, high: 85 },
};

/** context: <60 ok, 60-80 warn, >80 high. 5h and 7d: <60 ok, 60-85 warn, >85 high. */
export function levelFor(kind: MeterKind, pct: number): Level {
  const t = THRESHOLDS[kind];
  if (pct > t.high) return "high";
  if (pct >= t.warn) return "warn";
  return "ok";
}

export const LEVEL_WORD: Record<Level, string> = { ok: "ok", warn: "warning", high: "high" };

export const METER_NAME: Record<MeterKind, string> = {
  context: "context",
  five_hour: "5 hour window",
  seven_day: "7 day window",
};

export function clampPct(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}

/** 200000 -> "200k", 1000000 -> "1M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}k`;
}

/** "2h 10m", "35m", "<1m". Negative clamps to "<1m". */
export function formatDuration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** "in 2h 10m" within a day, otherwise the weekday ("Tue"). null when unknown. */
export function formatReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const left = resetsAt - now;
  if (left < 86_400_000) return `in ${formatDuration(left)}`;
  return new Date(resetsAt).toLocaleDateString("en-US", { weekday: "short" });
}

export function formatCost(usd: number | null): string {
  return usd === null ? "n/a" : `$${usd.toFixed(2)}`;
}

/** "Claude Opus 4.7" -> "Opus"; a transcript model id "claude-opus-5-5" -> "Opus". Falls back to the whole name. */
export function shortModel(displayName: string): string {
  const id = /^claude-([a-z]+)-\d/i.exec(displayName);
  if (id) return `${id[1]!.charAt(0).toUpperCase()}${id[1]!.slice(1).toLowerCase()}`;
  const parts = displayName.split(/\s+/).filter((p) => p.toLowerCase() !== "claude");
  return parts[0] ?? displayName;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function basename(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function formatClockSec(ts: number): string {
  return `${formatClock(ts)}:${String(new Date(ts).getSeconds()).padStart(2, "0")}`;
}
