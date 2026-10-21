// Pricing table, model lookup and cost formula.
//
// Borrowed from ryoppippi/ccusage (MIT, Copyright (c) 2025 ryoppippi), tag v19.0.3:
//   packages/internal/src/pricing.ts   (liteLLMModelPricingSchema, calculateTieredCost,
//                                       calculateCostFromPricing)
//   apps/ccusage/src/adapter/claude/data-loader.ts (createCostCalculator: model lookup order,
//                                       fast-speed multiplier)
//   apps/ccusage/src/pricing-fetcher.ts (CLAUDE_PROVIDER_PREFIXES)
// Changes: valibot replaced by zod; Result/byethrow dropped; the lookup cache is a per-table Map;
// the table carries its provenance label. Behavior (lookup order, 200k tier, fast multiplier) is
// kept identical so costs match ccusage for the same table.
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
  provider_specific_entry: z.object({ fast: rate }).optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}

function tiered(total: number | undefined, base: number | undefined, above: number | undefined) {
  if (total == null || total <= 0) return 0;
  if (total > TIER_THRESHOLD && above != null) {
    return (total - TIER_THRESHOLD) * above + (base != null ? TIER_THRESHOLD * base : 0);
  }
  return base != null ? total * base : 0;
}

export function costFromPricing(tokens: TokenCounts, p: ModelPricing): number {
  return (
    tiered(tokens.input_tokens, p.input_cost_per_token, p.input_cost_per_token_above_200k_tokens) +
    tiered(
      tokens.output_tokens,
      p.output_cost_per_token,
      p.output_cost_per_token_above_200k_tokens,
    ) +
    tiered(
      tokens.cache_creation_input_tokens,
      p.cache_creation_input_token_cost,
      p.cache_creation_input_token_cost_above_200k_tokens,
    ) +
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

  /** Cost of one usage block; 0 when the model is absent or unknown (ccusage behavior). */
  cost(tokens: TokenCounts, model: string | undefined, speed: string | undefined): number {
    if (model == null || model === "") return 0;
    const p = this.lookup(model);
    if (p == null) return 0;
    return (
      costFromPricing(tokens, p) * (speed === "fast" ? (p.provider_specific_entry?.fast ?? 1) : 1)
    );
  }
}
