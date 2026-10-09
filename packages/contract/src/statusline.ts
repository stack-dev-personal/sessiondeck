// Ported from sirmalloc/ccstatusline src/types/StatusJSON.ts @ 3b602348afbbe082eb919b576b55926bbf8d19d6 (MIT, Copyright (c) 2025 Matthew Breedlove)
// Changes: z.looseObject (zod 4) replaced by .passthrough() for zod 3; renamed to StatusLinePayloadSchema;
//   added spend_limit as documented in the Claude Code statusLine docs; every object passes unknown
//   keys through; rate-limit normalizer added (below).
//
// Ported from Maciek-roboblog/Claude-Code-Usage-Monitor src/claude_monitor/output/official.py @ c59a83bf943f329f0e61f1a29c760353ee1860a5 (MIT, Copyright (c) 2025 Maciej)
// Changes: _window/_clean_pct rewritten in TypeScript as normalizeRateLimitWindow. Behavior difference:
//   the original clamps 100 < pct <= 101 to 100; here any used_percentage outside 0..100 becomes null
//   (orchestrator decision for R0.4). Output uses the snapshot Window shape with resets_at in epoch ms.
import { z } from "zod";
import type { Window } from "./snapshot";

const CoercedNumberSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}, z.number());

const RateLimitPeriodSchema = z
  .object({
    used_percentage: CoercedNumberSchema.nullable().optional(),
    resets_at: CoercedNumberSchema.nullable().optional(), // Unix epoch SECONDS
  })
  .passthrough();

export type RateLimitPeriod = z.infer<typeof RateLimitPeriodSchema>;

// Also seen in the wild but undocumented: seven_day_sonnet, seven_day_opus (ccstatusline).
const RateLimitsSchema = z
  .object({
    five_hour: RateLimitPeriodSchema.optional(),
    seven_day: RateLimitPeriodSchema.optional(),
    seven_day_sonnet: RateLimitPeriodSchema.nullable().optional(),
    seven_day_opus: RateLimitPeriodSchema.nullable().optional(),
    spend_limit: RateLimitPeriodSchema.nullable().optional(),
  })
  .passthrough();

const PullRequestSchema = z
  .object({
    number: CoercedNumberSchema.optional(),
    url: z.string().optional(),
    review_state: z.string().optional(),
    kind: z.string().optional(),
  })
  .passthrough();

const PromptCacheSchema = z
  .object({
    warm: z.boolean().optional(),
    caching_observed: z.boolean().optional(),
    ttl: z.string().optional(),
    expires_at: CoercedNumberSchema.nullable().optional(), // Unix epoch SECONDS
  })
  .passthrough();

const CurrentUsageSchema = z
  .object({
    input_tokens: CoercedNumberSchema.optional(),
    output_tokens: CoercedNumberSchema.optional(),
    cache_creation_input_tokens: CoercedNumberSchema.optional(),
    cache_read_input_tokens: CoercedNumberSchema.optional(),
  })
  .passthrough();

const ContextWindowSchema = z
  .object({
    context_window_size: CoercedNumberSchema.nullable().optional(),
    total_input_tokens: CoercedNumberSchema.nullable().optional(),
    total_output_tokens: CoercedNumberSchema.nullable().optional(),
    current_usage: z.union([CoercedNumberSchema, CurrentUsageSchema]).nullable().optional(),
    used_percentage: CoercedNumberSchema.nullable().optional(),
    remaining_percentage: CoercedNumberSchema.nullable().optional(),
  })
  .passthrough();

export const StatusLinePayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    model: z
      .union([
        z.string(),
        z.object({ id: z.string().optional(), display_name: z.string().optional() }).passthrough(),
      ])
      .optional(),
    session_name: z.string().optional(),
    workspace: z
      .object({
        current_dir: z.string().optional(),
        project_dir: z.string().optional(),
        git_worktree: z.string().optional(),
      })
      .passthrough()
      .optional(),
    version: z.string().optional(),
    output_style: z.object({ name: z.string().optional() }).passthrough().optional(),
    effort: z
      .object({ level: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    cost: z
      .object({
        total_cost_usd: CoercedNumberSchema.optional(),
        total_duration_ms: CoercedNumberSchema.optional(),
        total_api_duration_ms: CoercedNumberSchema.optional(),
        total_lines_added: CoercedNumberSchema.optional(),
        total_lines_removed: CoercedNumberSchema.optional(),
      })
      .passthrough()
      .optional(),
    context_window: ContextWindowSchema.nullable().optional(),
    vim: z.object({ mode: z.string().optional() }).passthrough().nullable().optional(),
    worktree: z
      .object({
        name: z.string().optional(),
        path: z.string().optional(),
        branch: z.string().optional(),
        original_cwd: z.string().optional(),
        original_branch: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    rate_limits: RateLimitsSchema.nullable().optional(),
    pr: PullRequestSchema.optional(),
    prompt_cache: PromptCacheSchema.optional(),
  })
  .passthrough();

export type StatusLinePayload = z.infer<typeof StatusLinePayloadSchema>;

export function parseStatusLinePayload(input: unknown): StatusLinePayload {
  return StatusLinePayloadSchema.parse(input);
}

/** The payload's resets_at is epoch seconds; snapshot timestamps are epoch ms. */
export const MS_PER_SECOND = 1000;

/** Converts a payload timestamp (epoch seconds: resets_at, prompt_cache.expires_at) to epoch ms. */
export function epochSecondsToMs(seconds: number): number {
  return seconds * MS_PER_SECOND;
}
export const MIN_USED_PCT = 0;
export const MAX_USED_PCT = 100;

/**
 * Normalize one rate-limit window to the snapshot shape.
 * - used_percentage outside 0..100 or non-finite (bug #52326 leaks the resets_at epoch) becomes null.
 * - at or past resets_at the captured percentage is stale and becomes null.
 * Intended for five_hour and seven_day only: spend_limit.used_percentage legitimately exceeds 100
 * and would be nulled here.
 * Pure; never mutates raw.
 */
export function normalizeRateLimitWindow(
  raw: RateLimitPeriod | null | undefined,
  nowMs: number,
): Window {
  if (raw === null || raw === undefined) {
    return { used_pct: null, resets_at: null };
  }
  const pct = raw.used_percentage;
  const validPct =
    typeof pct === "number" && Number.isFinite(pct) && pct >= MIN_USED_PCT && pct <= MAX_USED_PCT
      ? pct
      : null;
  const resetsSec = raw.resets_at;
  const resetsAt =
    typeof resetsSec === "number" && Number.isFinite(resetsSec)
      ? epochSecondsToMs(resetsSec)
      : null;
  const expired = resetsAt !== null && nowMs >= resetsAt;
  return { used_pct: expired ? null : validPct, resets_at: resetsAt };
}
