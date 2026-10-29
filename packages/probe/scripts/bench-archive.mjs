// Archive importer bench (R5.2): 293 harness files must import in under 10 s. Builds a temp vault
// by replicating the 20 fixture captures with fresh session_ids, runs the real importer with an
// real file outbox (append + fsync) in a temp dir and prints three runs (full, unchanged, 5 touched). Exit 1 on FAIL.
//   node scripts/bench-archive.mjs        (Node 22.18+ runs the .ts sources directly)
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

// The importer imports the contract (extensionless TS), which plain Node cannot load, so bundle
// the real importer with esbuild (already a dev dependency of the build) into a temp file.
const bundleDir = mkdtempSync(join(tmpdir(), "sd-bench-archive-bundle-"));
await build({
  absWorkingDir: join(dirname(fileURLToPath(import.meta.url)), ".."),
  stdin: {
    contents:
      'export * from "./src/archive/importer.ts"; export { createOutbox } from "./src/daemon/outbox.ts";',
    resolveDir: join(dirname(fileURLToPath(import.meta.url)), ".."),
    loader: "ts",
  },
  outfile: join(bundleDir, "importer.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "warning",
});
const { ArchiveImporter, createOutbox } = await import(
  pathToFileURL(join(bundleDir, "importer.mjs")).href
);

const LIMIT_MS = 10_000;
const here = dirname(fileURLToPath(import.meta.url));
const fx = join(
  here,
  "..",
  "..",
  "contract",
  "fixtures",
  "vault",
  "harness",
  "agentic-harness",
  "sessions",
);
const sources = readdirSync(fx)
  .filter((f) => f.endsWith(".md"))
  .map((f) => readFileSync(join(fx, f), "utf8"));
const hex = (n) => n.toString(16).padStart(12, "0");

async function bench(count, replicate) {
  const dir = mkdtempSync(join(tmpdir(), "sd-bench-archive-"));
  const sessions = join(dir, "vault", "harness", "agentic-harness", "sessions");
  mkdirSync(sessions, { recursive: true });
  const paths = [];
  for (let i = 0; i < count; i++) {
    const src = sources[i % sources.length];
    // Fresh unique session_id per file; vary size with a repeated paragraph in the body.
    let text = src.replace(
      /^(session_id:\s*)["']?[0-9a-f-]+["']?/m,
      `$1"00000000-0000-4000-8000-${hex(i)}"`,
    );
    if (replicate) text += "\nExtra paragraph for size variation.".repeat((i * 37) % 400);
    const p = join(
      sessions,
      `2026-10-${String((i % 28) + 1).padStart(2, "0")}-${String(i).padStart(4, "0")}.md`,
    );
    writeFileSync(p, text);
    paths.push(p);
  }
  const outbox = createOutbox(join(dir, "home", "daemon", "outbox"));
  const imp = new ArchiveImporter({
    roots: [{ label: "bench", path: join(dir, "vault") }],
    statePath: join(dir, "home", "archive-index.json"),
    host: "bench",
    enqueue: outbox,
  });
  const out = [];
  const r1 = await imp.scan();
  out.push(`run 1 shipped=${r1.shipped} ms=${r1.ms}`);
  const r2 = await imp.scan();
  out.push(`run 2 shipped=${r2.shipped} ms=${r2.ms}`);
  const future = new Date(Date.now() + 60_000);
  for (const p of paths.slice(0, 5)) utimesSync(p, future, future);
  const r3 = await imp.scan();
  out.push(`run 3 shipped=${r3.shipped} ms=${r3.ms} (5 files touched)`);
  rmSync(dir, { recursive: true, force: true });
  const ok = r1.shipped === count && r2.shipped === 0 && r3.shipped === 5 && r1.ms < LIMIT_MS;
  return { out, ok, r1 };
}

let failed = false;
for (const [count, replicate] of [
  [20, false],
  [293, true],
]) {
  const { out, ok, r1 } = await bench(count, replicate);
  console.log(`--- ${count} files`);
  for (const l of out) console.log(l);
  console.log(`${ok ? "PASS" : "FAIL"} ${count} files: run 1 ${r1.ms} ms (limit ${LIMIT_MS} ms)`);
  if (!ok) failed = true;
}
rmSync(bundleDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
