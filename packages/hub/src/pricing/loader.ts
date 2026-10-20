// Pricing source precedence (R2.10): HUB_PRICING_FILE > cached copy of a previous fetch in the data
// dir > bundled snapshot. The optional startup fetch is the only outbound call the hub makes; it
// never blocks startup or ingest and every failure is logged and ignored.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import bundled from "./litellm-claude.json" with { type: "json" };
import { LITELLM_PRICING_URL, ModelPricingSchema, PricingTable, parseLiteLLM } from "./pricing.ts";

export const CACHE_FILE_NAME = "pricing-cache.json";
export const FETCH_TIMEOUT_MS = 5_000;
/** The real file is about 1.5 MB; anything near this is not the pricing table. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export interface PricingLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

const CacheFileSchema = z.object({
  fetched_at: z.number(),
  url: z.string(),
  models: z.record(ModelPricingSchema),
});

/** Holds the active table; swapped atomically when a fetch lands. Rebuilt from disk on restart. */
export class PricingProvider {
  constructor(private table: PricingTable) {}
  current(): PricingTable {
    return this.table;
  }
  set(t: PricingTable): void {
    this.table = t;
  }
}

export function bundledTable(): PricingTable {
  return new PricingTable(parseLiteLLM(bundled), "bundled");
}

export function cachePathFor(dbPath: string): string | null {
  return dbPath === ":memory:" || dbPath === ""
    ? null
    : path.join(path.dirname(dbPath), CACHE_FILE_NAME);
}

/** An explicit HUB_PRICING_FILE that cannot be read or has no models is a misconfiguration: throw. */
export function loadPricingFile(file: string): PricingTable {
  const models = parseLiteLLM(JSON.parse(readFileSync(file, "utf8")) as unknown);
  if (models.size === 0) throw new Error(`HUB_PRICING_FILE ${file} holds no model prices`);
  return new PricingTable(models, `file:${file}`);
}

/** Startup selection. A bad cache file falls through to the bundled table. */
export function loadPricing(opts: {
  file?: string | undefined;
  cachePath?: string | null | undefined;
  log?: PricingLog | undefined;
}): PricingTable {
  if (opts.file !== undefined) return loadPricingFile(opts.file);
  if (opts.cachePath) {
    try {
      const c = CacheFileSchema.parse(JSON.parse(readFileSync(opts.cachePath, "utf8")) as unknown);
      const models = parseLiteLLM(c.models);
      if (models.size > 0) return new PricingTable(models, `cache:${opts.cachePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        opts.log?.warn({ err: errName(err) }, "pricing cache unreadable, using bundled table");
      }
    }
  }
  return bundledTable();
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/**
 * One fetch attempt. Resolves to the new table, or null on any failure (logged). Never throws.
 * The fetched JSON is validated with zod before use and stored trimmed to the fields the hub reads.
 */
export async function refreshPricing(opts: {
  cachePath: string | null;
  log?: PricingLog | undefined;
  url?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<PricingTable | null> {
  const url = opts.url ?? LITELLM_PRICING_URL;
  try {
    const res = await (opts.fetchFn ?? fetch)(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) throw new Error("body too large");
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
    const models = parseLiteLLM(z.record(z.unknown()).parse(JSON.parse(text) as unknown));
    const usable = [...models.values()].filter((m) => m.input_cost_per_token !== undefined);
    if (usable.length === 0) throw new Error("no usable model prices");
    if (opts.cachePath) writeCache(opts.cachePath, url, models, opts.log);
    opts.log?.info({ models: models.size, cached: opts.cachePath !== null }, "pricing fetched");
    return new PricingTable(models, "fetch");
  } catch (err) {
    opts.log?.warn(
      { err: errName(err), reason: err instanceof Error ? err.message : "" },
      "pricing fetch failed",
    );
    return null;
  }
}

function writeCache(
  file: string,
  url: string,
  models: Map<string, unknown>,
  log?: PricingLog,
): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ fetched_at: Date.now(), url, models: Object.fromEntries(models) }),
      { mode: 0o600 },
    );
    renameSync(tmp, file);
  } catch (err) {
    // A cache that cannot be written only costs the next restart a fetch.
    log?.warn({ err: errName(err) }, "pricing cache not written");
  }
}
