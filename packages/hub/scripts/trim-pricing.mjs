// Builds the bundled pricing fallback from a LiteLLM model_prices_and_context_window.json.
//   node scripts/trim-pricing.mjs <source.json> [out.json]
// Keeps only Claude/Anthropic keys (case-insensitive "claude" or "anthropic" in the key) and only
// the fields the hub's cost calculation reads, in source key order (ccusage's substring fallback
// depends on iteration order). Prints the sha256 of the source for the provenance README.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost_above_200k_tokens",
];
const [src, out] = process.argv.slice(2);
if (!src) throw new Error("usage: trim-pricing.mjs <source.json> [out.json]");
const text = readFileSync(src);
const all = JSON.parse(text.toString("utf8"));
const trimmed = {};
for (const [key, v] of Object.entries(all)) {
  if (!/claude|anthropic/i.test(key) || typeof v !== "object" || v === null) continue;
  const e = {};
  for (const f of FIELDS) if (typeof v[f] === "number") e[f] = v[f];
  const fast = v.provider_specific_entry?.fast;
  if (typeof fast === "number") e.provider_specific_entry = { fast };
  trimmed[key] = e;
}
const dest = out ?? fileURLToPath(new URL("../src/pricing/litellm-claude.json", import.meta.url));
writeFileSync(dest, JSON.stringify(trimmed, null, 1) + "\n");
console.log(
  `models=${Object.keys(trimmed).length} source_sha256=${createHash("sha256").update(text).digest("hex")} -> ${dest}`,
);
