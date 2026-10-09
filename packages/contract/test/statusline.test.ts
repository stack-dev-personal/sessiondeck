import { describe, expect, it } from "vitest";
import {
  normalizeRateLimitWindow,
  parseStatusLinePayload,
  StatusLinePayloadSchema,
} from "../src/statusline";
import { loadFixtures } from "./helpers";

// SYNTHETIC samples built from the field list in docs/statusline.md. Not captured fixtures.
const RESETS_AT_SEC = 1_760_000_000;
const RESETS_AT_MS = RESETS_AT_SEC * 1000;

const base = {
  hook_event_name: "Status",
  session_id: "synthetic-session",
  cwd: "<HOME>/proj",
  model: { id: "synthetic-model", display_name: "Synthetic" },
  context_window: {
    context_window_size: 200000,
    used_percentage: 8,
    current_usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
  },
};

describe("StatusLinePayloadSchema", () => {
  it("parses a sample with rate_limits", () => {
    const sample = {
      ...base,
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: RESETS_AT_SEC },
        seven_day: { used_percentage: 41.2, resets_at: RESETS_AT_SEC + 1000 },
        seven_day_sonnet: null,
      },
    };
    const parsed = parseStatusLinePayload(sample);
    expect(parsed.rate_limits?.five_hour?.used_percentage).toBe(23.5);
  });

  it("parses a sample without rate_limits", () => {
    expect(parseStatusLinePayload(base).rate_limits).toBeUndefined();
    expect(parseStatusLinePayload({ ...base, rate_limits: null }).rate_limits).toBeNull();
  });

  it("parses current_usage null", () => {
    const parsed = parseStatusLinePayload({
      ...base,
      context_window: { ...base.context_window, current_usage: null, used_percentage: null },
    });
    expect(parsed.context_window?.current_usage).toBeNull();
  });

  it("coerces numeric strings and keeps unknown keys at every level", () => {
    const parsed = parseStatusLinePayload({
      ...base,
      brand_new_field: { x: 1 },
      rate_limits: { five_hour: { used_percentage: "12", resets_at: RESETS_AT_SEC, extra: true } },
    });
    expect(parsed["brand_new_field"]).toEqual({ x: 1 });
    expect(parsed.rate_limits?.five_hour?.used_percentage).toBe(12);
    expect(parsed.rate_limits?.five_hour?.["extra"]).toBe(true);
  });

  it("rejects a non-numeric percentage", () => {
    expect(
      StatusLinePayloadSchema.safeParse({ rate_limits: { five_hour: { used_percentage: "abc" } } })
        .success,
    ).toBe(false);
  });

  it("accepts numeric and whitespace-only strings per the ported coercion rules", () => {
    expect(
      StatusLinePayloadSchema.safeParse({
        context_window: { current_usage: 5, used_percentage: "  " },
      }).success,
    ).toBe(false);
    expect(
      StatusLinePayloadSchema.safeParse({ context_window: { current_usage: 5 } }).success,
    ).toBe(true);
  });
});

describe("normalizeRateLimitWindow", () => {
  const before = RESETS_AT_MS - 1000;

  it("keeps a valid percentage and converts resets_at to ms", () => {
    expect(
      normalizeRateLimitWindow({ used_percentage: 23.5, resets_at: RESETS_AT_SEC }, before),
    ).toEqual({
      used_pct: 23.5,
      resets_at: RESETS_AT_MS,
    });
  });

  it("nulls the #52326 leak (percentage carries the resets_at epoch)", () => {
    expect(
      normalizeRateLimitWindow(
        { used_percentage: 1_760_000_000, resets_at: RESETS_AT_SEC },
        before,
      ),
    ).toEqual({
      used_pct: null,
      resets_at: RESETS_AT_MS,
    });
  });

  it("nulls percentages just outside 0..100 and non-finite values", () => {
    expect(normalizeRateLimitWindow({ used_percentage: 100.5 }, 0).used_pct).toBeNull();
    expect(normalizeRateLimitWindow({ used_percentage: -1 }, 0).used_pct).toBeNull();
    expect(normalizeRateLimitWindow({ used_percentage: Number.NaN }, 0).used_pct).toBeNull();
    expect(normalizeRateLimitWindow({ used_percentage: 0 }, 0).used_pct).toBe(0);
    expect(normalizeRateLimitWindow({ used_percentage: 100 }, 0).used_pct).toBe(100);
  });

  it("nulls the percentage at and past resets_at, keeps it one second before", () => {
    const raw = { used_percentage: 50, resets_at: RESETS_AT_SEC };
    expect(normalizeRateLimitWindow(raw, RESETS_AT_MS - 1000).used_pct).toBe(50);
    expect(normalizeRateLimitWindow(raw, RESETS_AT_MS).used_pct).toBeNull();
    expect(normalizeRateLimitWindow(raw, RESETS_AT_MS + 1000).used_pct).toBeNull();
  });

  it("handles absent window, missing fields, and null fields", () => {
    expect(normalizeRateLimitWindow(undefined, 0)).toEqual({ used_pct: null, resets_at: null });
    expect(normalizeRateLimitWindow(null, 0)).toEqual({ used_pct: null, resets_at: null });
    expect(normalizeRateLimitWindow({}, 0)).toEqual({ used_pct: null, resets_at: null });
    expect(normalizeRateLimitWindow({ used_percentage: 5, resets_at: null }, 0)).toEqual({
      used_pct: 5,
      resets_at: null,
    });
  });

  it("does not mutate its input", () => {
    const raw = Object.freeze({ used_percentage: 1_760_000_000, resets_at: RESETS_AT_SEC });
    expect(() => normalizeRateLimitWindow(raw, 0)).not.toThrow();
  });
});

const statusFixtures = loadFixtures().filter((f) => f.dir === "statusLine");

// TODO(fixture): S0b un-skips this by committing fixtures/statusLine/*.json.
if (statusFixtures.length === 0)
  it.skip("TODO(fixture): no captured statusLine fixtures yet", () => {});
describe.skipIf(statusFixtures.length === 0)("captured statusLine fixtures", () => {
  it.each(statusFixtures.map((f) => [f.file, f] as const))("%s parses", (_name, fx) => {
    expect(StatusLinePayloadSchema.safeParse(fx.payload).success).toBe(true);
  });
});
