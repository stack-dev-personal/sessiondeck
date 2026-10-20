import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { PricingProvider, cachePathFor, loadPricing, refreshPricing } from "./pricing/loader.ts";
import { buildServer } from "./server.ts";

process.umask(0o077);
const config = loadConfig(process.env);
const store = Store.open(config.dbPath);
store.migrate();
const cachePath = cachePathFor(config.dbPath);
const pricing = new PricingProvider(loadPricing({ file: config.pricingFile, cachePath }));
const app = buildServer({ config, store, logger: true, pricing });
app.addHook("onClose", async () => store.close());
await app.listen({ port: config.port, host: config.bind });
app.log.info(
  { source: pricing.current().source, models: pricing.current().models.size },
  "pricing loaded",
);

// The only outbound call the hub makes. Not awaited: it never delays startup or ingest, and a
// failure leaves the table loaded above in place. An explicit HUB_PRICING_FILE wins, so no fetch.
if (config.pricingFetch && config.pricingFile === undefined) {
  void refreshPricing({ cachePath, log: app.log }).then((t) => {
    if (t !== null) pricing.set(t);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)));
}
