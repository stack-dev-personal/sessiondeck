// Quick parity check: compiled exe vs Node bundle for the same stdin (temp --home, never the real one).
// Usage: node scripts/parity-exe.mjs   (needs pnpm build && pnpm build:exe)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exeDir = join(
  root,
  "dist",
  "exe",
  process.platform === "win32" ? "windows-x64" : "linux-x64",
);
const ext = process.platform === "win32" ? ".exe" : "";
const fx = (p) => readFileSync(join(root, "..", "contract", "fixtures", p));
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label} ${detail}`);
  if (!ok) failed++;
};
const VOLATILE = new Set(["id", "ts", "received_at"]);
const strip = (o) =>
  JSON.stringify(
    Object.entries(o)
      .filter(([k]) => !VOLATILE.has(k))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

function run(kind, impl, input) {
  const home = mkdtempSync(join(tmpdir(), "sd-parity-"));
  const [cmd, pre] =
    impl === "node"
      ? [process.execPath, [join(root, "dist", `${kind}.mjs`)]]
      : [join(exeDir, `${kind}${ext}`), []];
  const args = [
    ...pre,
    "--home",
    home,
    "--host",
    "parity",
    ...(kind === "hook" ? ["--sessiondeck-probe"] : []),
  ];
  const r = spawnSync(cmd, args, { input, windowsHide: true });
  let lines = [];
  try {
    const sp = join(home, "spool");
    lines = readdirSync(sp).flatMap((f) =>
      readFileSync(join(sp, f), "utf8").split("\n").filter(Boolean),
    );
  } catch {
    // no spool dir: nothing was written
  }
  rmSync(home, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout.toString(), lines };
}

for (const [name, input] of [
  ["valid", fx("PostToolUse/04-bash.json")],
  ["empty", Buffer.alloc(0)],
  ["malformed", Buffer.from("{not json")],
]) {
  const n = run("hook", "node", input),
    e = run("hook", "exe", input);
  check(
    `hook ${name}: exit 0, no stdout`,
    e.status === 0 && e.stdout.length === 0,
    `exe status=${e.status} stdoutBytes=${e.stdout.length}`,
  );
  check(
    `hook ${name}: spool lines node=${n.lines.length} exe=${e.lines.length}`,
    n.lines.length === e.lines.length,
  );
  if (n.lines[0] && e.lines[0]) {
    const a = JSON.parse(n.lines[0]),
      b = JSON.parse(e.lines[0]);
    check(
      `hook ${name}: same fields`,
      JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) &&
        strip(a) === strip(b),
    );
  }
}
const sl = fx("statusLine/16-max-five-hour.json");
const n = run("statusline", "node", sl),
  e = run("statusline", "exe", sl);
check("statusline: exit 0", n.status === 0 && e.status === 0);
check("statusline: stdout identical", n.stdout === e.stdout, JSON.stringify(e.stdout));
for (const [name, input] of [
  ["empty", Buffer.alloc(0)],
  ["malformed", Buffer.from("{nope")],
]) {
  const a = run("statusline", "node", input),
    b = run("statusline", "exe", input);
  check(
    `statusline ${name}: exit 0, stdout identical to node`,
    b.status === 0 && a.stdout === b.stdout,
    JSON.stringify(b.stdout),
  );
}
process.exit(failed ? 1 : 0);
