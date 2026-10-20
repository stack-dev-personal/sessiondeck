// Preloaded into ccusage with `node --import`. Serves the LiteLLM pricing URL from the file named
// by CCUSAGE_COMPARE_PRICING and refuses every other fetch, so the comparison runs offline and
// both sides price from the same table.
import { readFileSync } from "node:fs";

const URL_PREFIX = "https://raw.githubusercontent.com/BerriAI/litellm/";
const file = process.env.CCUSAGE_COMPARE_PRICING;
if (!file) throw new Error("CCUSAGE_COMPARE_PRICING is not set");
const body = readFileSync(file, "utf8");
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  if (url.startsWith(URL_PREFIX)) {
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`network disabled by ccusage-fetch-shim: ${url}`);
};
