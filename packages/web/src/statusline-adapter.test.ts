import { createSnapshot } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import { statusLines } from "./mock/fixtures";
import { applyStatusLine, windowAt } from "./statusline-adapter";

const base = createSnapshot({ session_id: "s", host: "h", cwd: "/x", ts: 1 });
const NOW = 1_792_400_000_000;

describe("applyStatusLine (web-side adapter, contract has none)", () => {
  it("maps model, effort, cost, context and rate limits from a fixture", () => {
    const sample = JSON.parse(
      JSON.stringify(statusLines.find((s) => (s as { rate_limits?: unknown }).rate_limits)),
    ) as {
      rate_limits: { five_hour: { used_percentage: number; resets_at: number } };
      context_window: { used_percentage: number };
      cost: { total_cost_usd: number };
    };
    sample.rate_limits.five_hour.resets_at = Math.floor(NOW / 1000) + 7200;
    const s = applyStatusLine(base, sample, NOW);
    expect(s.model?.id).toBeTruthy();
    expect(s.context.window).toBeGreaterThan(0);
    expect(s.context.used_pct).toBe(sample.context_window.used_percentage);
    expect(s.cost.usd).toBe(sample.cost.total_cost_usd);
    expect(s.rate_limits.five_hour?.used_pct).toBe(sample.rate_limits.five_hour.used_percentage);
    expect(s.rate_limits.five_hour?.resets_at).toBe(sample.rate_limits.five_hour.resets_at * 1000);
    expect(s.last_event_at).toBe(NOW);
  });

  it("stale window becomes null, never the old number", () => {
    const s = applyStatusLine(
      base,
      { rate_limits: { five_hour: { used_percentage: 50, resets_at: 1000 } } },
      NOW,
    );
    expect(s.rate_limits.five_hour?.used_pct).toBeNull();
  });

  it("null context on first tick stays null; garbage payload only touches last_event_at", () => {
    expect(
      applyStatusLine(base, { context_window: { used_percentage: null } }, NOW).context.used_pct,
    ).toBeNull();
    const g = applyStatusLine(base, { model: 42 }, NOW);
    expect(g).toEqual({ ...base, last_event_at: NOW });
  });

  it("never mutates its input", () => {
    const frozen = structuredClone(base);
    applyStatusLine(base, statusLines[3], NOW);
    expect(base).toEqual(frozen);
  });

  it("every statusLine fixture applies without throwing", () => {
    for (const f of statusLines) expect(() => applyStatusLine(base, f, NOW)).not.toThrow();
  });

  it("windowAt returns null once resets_at has passed, by the current time", () => {
    const w = { used_pct: 41, resets_at: NOW + 1000 };
    expect(windowAt(w, NOW)).toEqual(w);
    expect(windowAt(w, NOW + 1000)).toEqual({ used_pct: null, resets_at: w.resets_at });
    expect(windowAt(w, NOW + 3_600_000).used_pct).toBeNull();
    expect(windowAt({ used_pct: 5, resets_at: null }, NOW).used_pct).toBe(5);
    expect(windowAt(null, NOW)).toEqual({ used_pct: null, resets_at: null });
  });

  it("a tick without rate_limits keeps the known windows and captured_at", () => {
    const first = applyStatusLine(
      base,
      {
        rate_limits: {
          five_hour: { used_percentage: 11, resets_at: Math.floor(NOW / 1000) + 7200 },
          seven_day: { used_percentage: 16, resets_at: Math.floor(NOW / 1000) + 86400 },
        },
      },
      NOW,
    );
    const next = applyStatusLine(first, { context_window: { used_percentage: 3 } }, NOW + 5000);
    expect(next.rate_limits).toEqual(first.rate_limits);
    expect(next.rate_limits.captured_at).toBe(NOW);
    expect(next.last_event_at).toBe(NOW + 5000);
  });
});
