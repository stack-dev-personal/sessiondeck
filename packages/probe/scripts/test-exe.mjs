// Builds the exes, then runs the exe suites (test:proc:exe config, serial); prints wall time.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (label, args) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  console.log(`[test:exe] ${label}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const t0 = Date.now();
run("build:exe", [join(root, "scripts", "build-exe.mjs")]);
const vitest = join(
  dirname(createRequire(join(root, "package.json")).resolve("vitest/package.json")),
  "vitest.mjs",
);
run("exe tests", [vitest, "run", "-c", "vitest.proc.exe.config.ts"]);
console.log(`[test:exe] total wall time: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
