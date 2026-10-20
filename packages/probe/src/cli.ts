// CLI entry (dist/probe.mjs): probe install | uninstall | config show. Unlike the hook, this exits
// non-zero on errors.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPathEnv } from "./paths.ts";
import { readProcessStdin, run } from "./install/run.ts";

const code = await run(process.argv.slice(2), {
  pathEnv: currentPathEnv(),
  distDir: dirname(fileURLToPath(import.meta.url)),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readStdin: readProcessStdin,
});
process.exitCode = code;
