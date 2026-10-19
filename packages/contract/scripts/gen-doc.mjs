// Regenerates the generated regions of docs/CONTRACT.md from the transition table.
//   pnpm -F @sessiondeck/contract gen:doc            rewrite the doc
//   pnpm -F @sessiondeck/contract gen:doc -- --check  exit 1 if the doc is out of date
// Bundles src/docblocks.ts with esbuild (a root devDependency) so no TypeScript loader flags are
// needed; works the same on Node 22 and 24, on Windows and Linux.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/docblocks.ts", import.meta.url));
const docPath = fileURLToPath(new URL("../../../docs/CONTRACT.md", import.meta.url));
const checkOnly = process.argv.includes("--check");

const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const code = bundle.outputFiles[0].text;
const { DOC_BLOCK_NAMES, renderDocBlocks, replaceBlock } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

const blocks = renderDocBlocks();
const current = await readFile(docPath, "utf8");
let next = current.replace(/\r\n/g, "\n");
for (const name of DOC_BLOCK_NAMES) {
  next = replaceBlock(next, name, blocks[name]);
}

if (checkOnly) {
  if (next !== current.replace(/\r\n/g, "\n")) {
    console.error("docs/CONTRACT.md is out of date. Run: pnpm -F @sessiondeck/contract gen:doc");
    process.exit(1);
  }
  console.log("docs/CONTRACT.md is up to date.");
} else {
  await writeFile(docPath, next, "utf8");
  console.log("docs/CONTRACT.md updated.");
}
