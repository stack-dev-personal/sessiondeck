// Bundles a hub TypeScript entry with esbuild (a root devDependency). Needed because the contract
// package is TypeScript with extensionless imports, which `node --experimental-strip-types` cannot load.
//   node scripts/bundle.mjs src/main.ts dist/main.mjs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const [entry, out] = process.argv.slice(2);
if (!entry || !out) throw new Error("usage: bundle.mjs <entry.ts> <out.mjs>");
await build({
  entryPoints: [path.resolve(root, entry)],
  outfile: path.resolve(root, out),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Native or dynamic-require packages stay in node_modules; the contract and zod are bundled.
  external: ["better-sqlite3", "fastify", "ws", "prettier"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});
