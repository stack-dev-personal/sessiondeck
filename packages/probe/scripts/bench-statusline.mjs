// Statusline latency (informational, not under R1.1): spawns `node dist/statusline.mjs` 100 times
// with a fixture on stdin. Prints p50/p95/max wall ms. Always exits 0.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = 100;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "dist", "statusline.mjs");
const fixture = readFileSync(
  join(root, "..", "contract", "fixtures", "statusLine", "16-max-five-hour.json"),
);
const home = mkdtempSync(join(tmpdir(), "sd-bench-sl-"));
const times = [];
let bad = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [script, "--home", home, "--host", "bench"], {
    input: fixture,
    windowsHide: true,
  });
  times.push(performance.now() - t0);
  if (r.status !== 0 || r.stdout.toString().split("\n").filter(Boolean).length !== 1) bad++;
}
rmSync(home, { recursive: true, force: true });
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)];
console.log(`runs: ${RUNS}  bad: ${bad}`);
console.log(
  `p50: ${pct(50).toFixed(1)} ms  p95: ${pct(95).toFixed(1)} ms  max: ${times.at(-1).toFixed(1)} ms`,
);
process.exit(0);
