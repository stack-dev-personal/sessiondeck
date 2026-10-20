import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { buildServer } from "./server.ts";

const config = loadConfig(process.env);
const store = Store.open(config.dbPath);
store.migrate();
const app = buildServer({ config, store, logger: true });
app.addHook("onClose", async () => store.close());
await app.listen({ port: config.port, host: config.bind });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)));
}
