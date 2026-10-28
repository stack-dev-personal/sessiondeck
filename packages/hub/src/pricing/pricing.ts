// Pricing table, model lookup and cost formula.
//
// Borrowed from ryoppippi/ccusage (MIT, Copyright (c) 2025 ryoppippi), tag v19.0.3:
//   packages/internal/src/pricing.ts   (liteLLMModelPricingSchema, calculateTieredCost,
//                                       calculateCostFromPricing)
//   apps/ccusage/src/adapter/claude/data-loader.ts (createCostCalculator: model lookup order,
//                                       fast-speed multiplier)
//   apps/ccusage/src/pricing-fetcher.ts (CLAUDE_PROVIDER_PREFIXES)
// Changes: valibot replaced by zod; Result/byethrow dropped; the lookup cache is a per-table Map;
// the table carries its provenance label. Lookup order, 200k tier and fast multiplier are kept
// identical to ccusage. Deviation (decision 25): cache writes are split by TTL when the usage row
// carries cache_creation.ephemeral_{1h,5m}_input_tokens; 1-hour writes are priced at the 1-hour
// rate (2x input unless the table has one), 5-minute writes at the 5-minute rate. ccusage prices
// every write at the 5-minute rate; `splitCacheWrites: false` restores that for comparison.
import { z } from "zod";

export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** ccusage's apps/ccusage/src/pricing-fetcher.ts CLAUDE_PROVIDER_PREFIXES, in order. */
const PROVIDER_PREFIXES = [
  "anthropic/",
  "claude-3-5-",
  "claude-3-",
  "claude-",
  "openrouter/openai/",
];

const TIER_THRESHOLD = 200_000;
const MEMO_MAX = 1000;

/** Rates are finite and non-negative; a negative or 1e999 rate makes the entry invalid (skipped). */
const rate = z.number().finite().nonnegative().optional();

export const ModelPricingSchema = z.object({
  input_cost_per_token: rate,
  output_cost_per_token: rate,
  cache_creation_input_token_cost: rate,
  cache_read_input_token_cost: rate,
  input_cost_per_token_above_200k_tokens: rate,
  output_cost_per_token_above_200k_tokens: rate,
  cache_creation_input_token_cost_above_200k_tokens: rate,
  cache_read_input_token_cost_above_200k_tokens: rate,
  /** Optional 1-hour cache-write rates (LiteLLM field names); absent means derive 2x input. */
  cache_creation_input_token_cost_above_1hr: rate,
  cache_creation_input_token_cost_above_1hr_above_200k_tokens: rate,
  provider_specific_entry: z.object({ fast: rate }).optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
  /** Cache writes by TTL (message.usage.cache_creation); absent when the row has no split. */
  cache_creation_1h_tokens?: number | undefined;
  cache_creation_5m_tokens?: number | undefined;
}

function tiered(total: number | undefined, base: number | undefined, above: number | undefined) {
  if (total == null || total <= 0) return 0;
  if (total > TIER_THRESHOLD && above != null) {
    return (total - TIER_THRESHOLD) * above + (base != null ? TIER_THRESHOLD * base : 0);
  }
  return base != null ? total * base : 0;
}

/** 1-hour write rates: table field if present, else 2x the input rate of the same tier. */
function oneHourRates(p: ModelPricing): { base: number | undefined; above: number | undefined } {
  const base =
    p.cache_creation_input_token_cost_above_1hr ??
    (p.input_cost_per_token != null ? 2 * p.input_cost_per_token : undefined);
  const above =
    p.cache_creation_input_token_cost_above_1hr_above_200k_tokens ??
    (p.input_cost_per_token_above_200k_tokens != null
      ? 2 * p.input_cost_per_token_above_200k_tokens
      : undefined);
  return { base, above };
}

/**
 * Cache-write cost. With a TTL split, h = 1-hour tokens, f = 5-minute tokens, and any remainder of
 * cache_creation_input_tokens not covered by h + f is priced at the 5-minute rate; if h + f exceeds
 * the total, the split wins (the total is only the remainder source). All writes are tiered as one
 * quantity (200k threshold), and the 1-hour share (h / total) is priced at the 1-hour rates, so a
 * row with h = 0 prices exactly as ccusage does.
 */
function cacheWriteCost(tokens: TokenCounts, p: ModelPricing, split: boolean): number {
  const total = tokens.cache_creation_input_tokens ?? 0;
  const h = split ? (tokens.cache_creation_1h_tokens ?? 0) : 0;
  const f = split ? (tokens.cache_creation_5m_tokens ?? 0) : 0;
  const all = Math.max(total, h + f);
  const at5m = tiered(
    all,
    p.cache_creation_input_token_cost,
    p.cache_creation_input_token_cost_above_200k_tokens,
  );
  if (h <= 0 || all <= 0) return at5m;
  const r = oneHourRates(p);
  // No 1-hour rate derivable (table has no input rate either): fall back to the 5-minute rate.
  if (r.base == null) return at5m;
  const at1h = tiered(all, r.base, r.above);
  return at5m + (h / all) * (at1h - at5m);
}

export function costFromPricing(tokens: TokenCounts, p: ModelPricing, split = true): number {
  return (
    tiered(tokens.input_tokens, p.input_cost_per_token, p.input_cost_per_token_above_200k_tokens) +
    tiered(
      tokens.output_tokens,
      p.output_cost_per_token,
      p.output_cost_per_token_above_200k_tokens,
    ) +
    cacheWriteCost(tokens, p, split) +
    tiered(
      tokens.cache_read_input_tokens,
      p.cache_read_input_token_cost,
      p.cache_read_input_token_cost_above_200k_tokens,
    )
  );
}

/**
 * Parses a LiteLLM-shaped object. Entries that are not objects or fail the schema are skipped, as
 * ccusage does (e.g. LiteLLM's "sample_spec"). Source key order is kept.
 */
export function parseLiteLLM(json: unknown): Map<string, ModelPricing> {
  const out = new Map<string, ModelPricing>();
  if (typeof json !== "object" || json === null || Array.isArray(json)) return out;
  for (const [name, v] of Object.entries(json)) {
    const r = ModelPricingSchema.safeParse(v);
    if (r.success) out.set(name, r.data);
  }
  return out;
}

export class PricingTable {
  private readonly memo = new Map<string, ModelPricing | null>();
  constructor(
    readonly models: Map<string, ModelPricing>,
    /** Where the table came from, for logs: "file:<path>", "cache:<path>", "fetch", "bundled". */
    readonly source: string,
    /** false prices every cache write at the 5-minute rate (ccusage behavior). */
    readonly splitCacheWrites = true,
  ) {}

  /** ccusage createCostCalculator order: exact, provider prefixes, then first substring match. */
  lookup(model: string): ModelPricing | null {
    const memo = this.memo.get(model);
    if (memo !== undefined) return memo;
    const found = this.find(model);
    // Model strings come from transcripts: bound the memo so junk names cannot grow it.
    if (this.memo.size < MEMO_MAX) this.memo.set(model, found);
    return found;
  }

  private find(model: string): ModelPricing | null {
    const direct = this.models.get(model);
    if (direct != null) return direct;
    for (const prefix of PROVIDER_PREFIXES) {
      const p = this.models.get(`${prefix}${model}`);
      if (p != null) return p;
    }
    const lower = model.toLowerCase();
    for (const [key, value] of this.models) {
      const k = key.toLowerCase();
      if (k.includes(lower) || lower.includes(k)) return value;
    }
    return null;
  }

  /** True when the model resolves to a pricing entry. */
  isPriced(model: string): boolean {
    return this.lookup(model) !== null;
  }

  /** Cost of one usage block; 0 when the model is absent or unknown (callers report unknowns). */
  cost(tokens: TokenCounts, model: string | undefined, speed: string | undefined): number {
    if (model == null || model === "") return 0;
    const p = this.lookup(model);
    if (p == null) return 0;
    return (
      costFromPricing(tokens, p, this.splitCacheWrites) *
      (speed === "fast" ? (p.provider_specific_entry?.fast ?? 1) : 1)
    );
  }
}
