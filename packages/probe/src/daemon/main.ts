// Daemon entry (dist/daemon.mjs): `node daemon.mjs [--home <dir>] [--stderr]`. See run.ts.
import { runDaemon } from "./run.ts";

await runDaemon(process.argv.slice(2));
