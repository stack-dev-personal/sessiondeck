// Latency harness (R1.1): spawns `node dist/hook.mjs` 200 times, sequentially, with a fixture on
// stdin and `--home <tmp>` (the way `probe install` registers the hook). Prints p50/p95/max wall ms and machine info. Always exits 0.
// Usage: node scripts/bench-hook.mjs [--target node|exe|bun-floor]   (default node)
//   exe and bun-floor need `pnpm build && pnpm build:exe`. Spool and config go to a temp --home, never the real one.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir, platform, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTarget, resolveCommand } from "./bench-target.mjs";

const RUNS = 200;
const LIMIT_MS = 80;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = parseTarget(process.argv);
const { cmd, prefix } = resolveCommand(root, "hook", target);
const fixture = readFileSync(
  join(root, "..", "contract", "fixtures", "PostToolUse", "04-bash.json"),
);
const home = mkdtempSync(join(tmpdir(), "sd-bench-"));

const times = [];
let bad = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = spawnSync(cmd, [...prefix, "--home", home, "--host", "bench", "--sessiondeck-probe"], {
    input: fixture,
    windowsHide: true,
  });
  times.push(performance.now() - t0);
  if (r.status !== 0 || r.stdout.length > 0) bad++;
}
rmSync(home, { recursive: true, force: true });

times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)];
const p95 = pct(95);
console.log(`target: ${target}`);
console.log(`runs: ${RUNS}  bad exits/stdout: ${bad}`);
console.log(
  `p50: ${pct(50).toFixed(1)} ms  p95: ${p95.toFixed(1)} ms  max: ${times.at(-1).toFixed(1)} ms`,
);
console.log(
  `machine: ${platform()} ${release()} ${arch()} | ${cpus()[0]?.model} x${cpus().length} | node ${process.version}`,
);
console.log(
  p95 < LIMIT_MS ? "R1.1 PASS" : `R1.1 FAIL (p95 >= ${LIMIT_MS} ms; A15 is the user's decision)`,
);
process.exit(0);
