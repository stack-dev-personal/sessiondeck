// Statusline latency (informational, not under R1.1): spawns `node dist/statusline.mjs` 100 times
// with a fixture on stdin. Prints p50/p95/max wall ms. Always exits 0.
// Usage: node scripts/bench-statusline.mjs [--target node|exe|bun-floor]   (default node)
//   exe and bun-floor need `pnpm build && pnpm build:exe`. Uses a temp --home, never the real one.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTarget, resolveCommand } from "./bench-target.mjs";

const RUNS = 100;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = parseTarget(process.argv);
const { cmd, prefix } = resolveCommand(root, "statusline", target);
const fixture = readFileSync(
  join(root, "..", "contract", "fixtures", "statusLine", "16-max-five-hour.json"),
);
const home = mkdtempSync(join(tmpdir(), "sd-bench-sl-"));
// Worst case for the state lookup: a full 64 KB tail of lines for other sessions (no match).
const day = new Date().toISOString().slice(0, 10) + ".jsonl";
mkdirSync(join(home, "spool"), { recursive: true });
const filler =
  JSON.stringify({
    v: 1,
    kind: "hook",
    session_id: "other",
    hook_event_name: "Stop",
    payload: {},
  }) + "\n";
writeFileSync(join(home, "spool", day), filler.repeat(Math.ceil(70000 / filler.length)));
const times = [];
let bad = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = spawnSync(cmd, [...prefix, "--home", home, "--host", "bench"], {
    input: fixture,
    windowsHide: true,
  });
  times.push(performance.now() - t0);
  // The floor prints nothing by design; real targets print exactly one line.
  const lines = r.stdout.toString().split("\n").filter(Boolean).length;
  if (r.status !== 0 || lines !== (target === "bun-floor" ? 0 : 1)) bad++;
}
rmSync(home, { recursive: true, force: true });
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)];
console.log(`target: ${target}`);
console.log(`runs: ${RUNS}  bad: ${bad}`);
console.log(
  `p50: ${pct(50).toFixed(1)} ms  p95: ${pct(95).toFixed(1)} ms  max: ${times.at(-1).toFixed(1)} ms`,
);
process.exit(0);
