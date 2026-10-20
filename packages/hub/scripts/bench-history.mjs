#!/usr/bin/env node
// Bundles scripts/bench-history.ts the way ccusage-compare.mjs bundles compare-hub.ts, then runs it.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "..", "dist", "bench-history.mjs");
await build({
  entryPoints: [path.join(here, "bench-history.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["better-sqlite3", "fastify", "ws"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
  absWorkingDir: path.join(here, ".."),
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
