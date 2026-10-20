// Bundles each probe entry into one minified ESM file under dist/. The hook must not pull zod or
// any other dependency: it imports only node builtins and type-only contract symbols.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const entries = {
  hook: "src/hook.ts",
  statusline: "src/statusline.ts",
  subagents: "src/subagents.ts",
  probe: "src/cli.ts",
};

await build({
  absWorkingDir: root,
  entryPoints: entries,
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
