import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { PricingProvider, cachePathFor, loadPricing, refreshPricing } from "./pricing/loader.ts";
import { startLease } from "./lease.ts";
import { startRetentionTimer } from "./retention.ts";
import { buildServer } from "./server.ts";

export async function serve(): Promise<void> {
  const config = loadConfig(process.env);
  const store = Store.open(config.dbPath);
  store.migrate();
  const cachePath = cachePathFor(config.dbPath);
  // The logger does not exist until the server is built, which needs the table: hold early lines.
  const early: Array<{ level: "info" | "warn"; obj: object; msg: string }> = [];
  const pricing = new PricingProvider(
    loadPricing({
      file: config.pricingFile,
      cachePath,
      log: {
        info: (obj, msg) => early.push({ level: "info", obj, msg }),
        warn: (obj, msg) => early.push({ level: "warn", obj, msg }),
      },
    }),
  );
  const app = buildServer({ config, store, logger: true, pricing });
  for (const l of early) app.log[l.level](l.obj, l.msg);
  const retention = startRetentionTimer(store, app.log, {
    eventRetentionDays: config.eventRetentionDays,
    sampleRetentionDays: config.sampleRetentionDays,
    maxOpenSessionsPerHost: config.maxOpenSessionsPerHost,
    intervalMs: config.retentionIntervalMs,
    maxClockSkewMs: config.maxClockSkewMs,
    compactBatchSize: config.compactBatchSize,
    compactBatchBudgetMs: config.compactBatchBudgetMs,
  });
  const lease = startLease(store, app.log);
  app.addHook("onClose", async () => {
    retention.stop();
    lease.stop();
    store.close();
  });
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
}
