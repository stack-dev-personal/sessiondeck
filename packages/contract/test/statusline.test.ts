import { describe, expect, it } from "vitest";
import {
  epochSecondsToMs,
  normalizeRateLimitWindow,
  parseStatusLinePayload,
  StatusLinePayloadSchema,
} from "../src/statusline";
import { loadFixtures } from "./helpers";
import type { RateLimitPeriod } from "../src/statusline";

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

  it("rejects whitespace-only strings, accepts numeric current_usage", () => {
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

describe("typed optional keys", () => {
  it("types session_name, pr, prompt_cache and workspace.git_worktree and keeps extras", () => {
    const parsed = parseStatusLinePayload({
      session_name: "my-session",
      workspace: { git_worktree: "feature-xyz", added_dirs: [] },
      pr: { number: "12", url: "https://example.test/pull/12", review_state: "pending", x: 1 },
      prompt_cache: { warm: true, ttl: "1h", expires_at: 1738429200, hit_ratio: 0.9 },
    });
    expect(parsed.session_name).toBe("my-session");
    expect(parsed.workspace?.git_worktree).toBe("feature-xyz");
    expect(parsed.pr?.number).toBe(12);
    expect(parsed.pr?.["x"]).toBe(1);
    expect(parsed.prompt_cache?.expires_at).toBe(1738429200);
    expect(parsed.prompt_cache?.["hit_ratio"]).toBe(0.9);
  });

  it("rejects wrongly typed values for the typed keys", () => {
    expect(StatusLinePayloadSchema.safeParse({ pr: { number: "twelve" } }).success).toBe(false);
    expect(StatusLinePayloadSchema.safeParse({ session_name: 5 }).success).toBe(false);
    expect(StatusLinePayloadSchema.safeParse({ prompt_cache: { warm: "yes" } }).success).toBe(
      false,
    );
    expect(StatusLinePayloadSchema.safeParse({ workspace: { git_worktree: 1 } }).success).toBe(
      false,
    );
  });
});

describe("epochSecondsToMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(epochSecondsToMs(1738429200)).toBe(1738429200000);
    expect(epochSecondsToMs(0)).toBe(0);
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

const allFixtures = loadFixtures();
const statusFixtures = allFixtures.filter((f) => f.dir === "statusLine");
const subagentFixtures = allFixtures.filter((f) => f.dir === "subagentStatusLine");
const CAPTURED_STATUSLINE_COUNT = 20;
const CAPTURED_SUBAGENT_COUNT = 5;

function parsedFixtures() {
  return statusFixtures.map((f) => StatusLinePayloadSchema.parse(f.payload));
}

describe("captured statusLine fixtures", () => {
  it("walks all 20 statusLine samples and 5 subagentStatusLine samples (never an empty walk)", () => {
    expect(statusFixtures).toHaveLength(CAPTURED_STATUSLINE_COUNT);
    expect(subagentFixtures).toHaveLength(CAPTURED_SUBAGENT_COUNT);
  });

  it.each(statusFixtures.map((f) => [f.file, f] as const))("statusLine %s parses", (_name, fx) => {
    expect(StatusLinePayloadSchema.safeParse(fx.payload).success).toBe(true);
  });

  it.each(subagentFixtures.map((f) => [f.file, f] as const))(
    "subagentStatusLine %s parses and keeps its row list",
    (_name, fx) => {
      const parsed = StatusLinePayloadSchema.safeParse(fx.payload);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(Array.isArray(parsed.data["tasks"])).toBe(true);
    },
  );

  it("covers the R0.4 cases: with rate_limits, without, and current_usage null", () => {
    const all = parsedFixtures();
    expect(all.some((p) => p.rate_limits != null)).toBe(true);
    expect(all.some((p) => p.rate_limits == null)).toBe(true);
    expect(all.some((p) => p.context_window?.current_usage === null)).toBe(true);
  });

  it("normalizes every captured five_hour and seven_day window", () => {
    const windows: RateLimitPeriod[] = parsedFixtures().flatMap((p) =>
      [p.rate_limits?.five_hour, p.rate_limits?.seven_day].filter(
        (w): w is RateLimitPeriod => w != null,
      ),
    );
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      const out = normalizeRateLimitWindow(w, 0);
      expect(out.used_pct === null || (out.used_pct >= 0 && out.used_pct <= 100)).toBe(true);
    }
  });

  it("DERIVED from a captured sample (the capture has no leak): a percentage above 100 becomes null (#52326)", () => {
    const source = statusFixtures.find((f) => {
      const w = StatusLinePayloadSchema.parse(f.payload).rate_limits?.five_hour;
      return w != null && typeof w.resets_at === "number";
    });
    expect(source).toBeDefined();
    const clone = structuredClone(source?.payload) as {
      rate_limits: { five_hour: { used_percentage: unknown } };
    };
    clone.rate_limits.five_hour.used_percentage = 1_760_000_000;
    const window = StatusLinePayloadSchema.parse(clone).rate_limits?.five_hour;
    expect(normalizeRateLimitWindow(window, 0).used_pct).toBeNull();
  });
});
