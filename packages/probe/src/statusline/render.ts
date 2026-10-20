/** Pure rendering of the one-line status bar. Never throws; no dependency on the contract's zod. */
export const FALLBACK_LINE = "sessiondeck";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Numbers, or numeric strings (the contract coerces them the same way). */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// C0, DEL, C1 controls and the Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");

/** Single-line, printable text: control characters and line breaks become spaces. */
export function oneLine(s: string, max = 40): string {
  const t = s.replace(CONTROL, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

const pct = (n: number): string => `${Math.round(n)}%`;

function modelName(p: Obj): string | null {
  const m = p["model"];
  if (typeof m === "string") return m.trim() === "" ? null : oneLine(m);
  if (isObj(m)) {
    const n = m["display_name"] ?? m["id"];
    if (typeof n === "string" && n.trim() !== "") return oneLine(n);
  }
  return null;
}

/** used_percentage when it is 0..100, else computed from current_usage / context_window_size. */
export function contextPct(p: Obj): number | null {
  const cw = p["context_window"];
  if (!isObj(cw)) return null;
  const used = num(cw["used_percentage"]);
  if (used !== null && used >= 0 && used <= 100) return used;
  const size = num(cw["context_window_size"]);
  if (size === null || size <= 0) return null;
  const cu = cw["current_usage"];
  let tokens: number | null = null;
  if (isObj(cu)) {
    const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map(
      (k) => num(cu[k]),
    );
    if (parts.some((x) => x !== null)) tokens = parts.reduce<number>((a, x) => a + (x ?? 0), 0);
  } else {
    tokens = num(cu);
  }
  if (tokens === null || tokens < 0) return null;
  return Math.min(100, (tokens / size) * 100);
}

/** Same rules as the contract's normalizeRateLimitWindow: out of 0..100 or past resets_at is stale. */
export function windowPct(w: unknown, nowMs: number): number | null {
  if (!isObj(w)) return null;
  const p = num(w["used_percentage"]);
  if (p === null || p < 0 || p > 100) return null;
  const r = num(w["resets_at"]); // epoch seconds
  if (r !== null && nowMs >= r * 1000) return null;
  return p;
}

/**
 * `<model> [effort] | ctx 38% | 5h 78% | 7d 35% [| $1.23]`. Fields Claude does not give us show
 * `n/a` (ctx, 5h, 7d always appear); absent rate_limits (API-key plan) shows `5h n/a | 7d n/a`.
 */
export function renderStatusLine(payload: unknown, nowMs: number = Date.now()): string {
  try {
    if (!isObj(payload)) return FALLBACK_LINE;
    const rl = isObj(payload["rate_limits"]) ? payload["rate_limits"] : {};
    const eff = isObj(payload["effort"]) ? payload["effort"]["level"] : null;
    const head =
      [modelName(payload), typeof eff === "string" ? oneLine(eff, 12) : null]
        .filter((x): x is string => x !== null && x !== "")
        .join(" ") || FALLBACK_LINE;
    const c = contextPct(payload);
    const f = windowPct(rl["five_hour"], nowMs);
    const s = windowPct(rl["seven_day"], nowMs);
    const parts = [
      head,
      `ctx ${c === null ? "n/a" : pct(c)}`,
      `5h ${f === null ? "n/a" : pct(f)}`,
      `7d ${s === null ? "n/a" : pct(s)}`,
    ];
    const cost = isObj(payload["cost"]) ? num(payload["cost"]["total_cost_usd"]) : null;
    if (cost !== null && cost >= 0) parts.push(`$${cost.toFixed(2)}`);
    return parts.join(" | ");
  } catch {
    return FALLBACK_LINE;
  }
}
