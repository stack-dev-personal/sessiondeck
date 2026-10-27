// Compiles the hook, statusline and subagents Node bundles (dist/*.mjs, from build.mjs) into
// single-file Bun executables (A15 fallback for R1.1; Linux x64 for WSL2, R1.11):
//   dist/exe/windows-x64/{hook,statusline,subagents}.exe
//   dist/exe/linux-x64/{hook,statusline,subagents}
// plus bun-floor (a hello-world exe, the startup floor for the benches) in each directory.
// Usage: node scripts/build-exe.mjs [--no-bytecode] [--host-only]   (run `pnpm build` first)
//   --host-only: build only the current platform target and skip bun-floor (CI: build:exe:host).
// Host rules (scripts/exe-targets.mjs): win32 builds both targets; linux builds linux-x64 only and
// skips windows-x64 with a notice. Non-native targets use a pinned local base, never a download.
// Bun is a build tool only (MIT); no code is copied. The exe never autoloads .env or bunfig.toml
// from the cwd (Claude Code runs hooks with cwd = the user's project).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectTargets } from "./exe-targets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..").replaceAll("\\", "/");
const hostOnly = process.argv.includes("--host-only");
const useBytecode = !process.argv.includes("--no-bytecode");

function fail(message) {
  console.error(`build-exe: ${message}`);
  process.exit(1);
}

function pinned(fromBun, pkg, label) {
  let p;
  try {
    p = dirname(fromBun.resolve(pkg + "/package.json"));
  } catch (err) {
    return fail(`cannot resolve pinned ${label} (${pkg}): ${err.message}. Run pnpm install.`);
  }
  return p;
}

// bun npm package: bin/bun.exe on every OS (postinstall swaps in the native binary); accept bin/bun too.
function resolveBun(needLinuxBase) {
  const fromProbe = createRequire(join(root, "package.json"));
  let bunDir;
  try {
    bunDir = dirname(fromProbe.resolve("bun/package.json"));
  } catch (err) {
    return fail(`cannot resolve the pinned bun package: ${err.message}. Run pnpm install.`);
  }
  const candidates = ["bun.exe", "bun"].map((n) => join(bunDir, "bin", n).replaceAll("\\", "/"));
  const host = candidates.find((c) => existsSync(c));
  if (!host) return fail(`bun binary not found (${candidates.join(", ")}); run pnpm install`);
  let linuxBase = null;
  if (needLinuxBase) {
    const dir = pinned(
      createRequire(join(bunDir, "package.json")),
      "@oven/bun-linux-x64",
      "linux x64 base",
    );
    linuxBase = join(dir, "bin", "bun").replaceAll("\\", "/");
    if (!existsSync(linuxBase))
      return fail(`linux x64 base not found at ${linuxBase}; run pnpm install`);
  }
  return { host, linuxBase };
}

let selection;
try {
  selection = selectTargets(process.platform, { hostOnly });
} catch (err) {
  fail(err.message);
}
for (const n of selection.notices) console.log(n);
const bun = resolveBun(selection.targets.some((t) => t.cross));
// Cross targets only ever use the pinned local base; bun must never download one.
const targets = selection.targets.map((t) => ({
  ...t,
  args: t.cross ? ["--target=bun-linux-x64", `--compile-executable-path=${bun.linuxBase}`] : [],
}));
const programs = [
  ["hook", `${root}/dist/hook.mjs`],
  ["statusline", `${root}/dist/statusline.mjs`],
  ["subagents", `${root}/dist/subagents.mjs`],
  ...(selection.includeFloor ? [["bun-floor", `${root}/scripts/bun-floor.mjs`]] : []),
];

// SHA-256 of the dist bundles these exes are built from; `probe install` refuses exes that do not
// match the current dist/*.mjs (sources.json next to the exes).
const sources = {};
for (const bundle of ["hook.mjs", "statusline.mjs", "subagents.mjs"]) {
  const file = `${root}/dist/${bundle}`;
  if (!existsSync(file)) fail(`missing ${file}; run pnpm build first`);
  sources[bundle] = createHash("sha256").update(readFileSync(file)).digest("hex");
}

for (const t of targets) {
  const outDir = `${root}/dist/exe/${t.dir}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/sources.json`,
    `${JSON.stringify(sources, null, 2)}
`,
  );
  for (const [name, entry] of programs) {
    if (!existsSync(entry)) fail(`missing ${entry}; run pnpm build first`);
    const outfile = `${outDir}/${name}${t.ext}`;
    const args = [
      "build",
      "--compile",
      "--minify",
      ...(useBytecode ? ["--bytecode"] : []),
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      ...t.args,
      entry,
      `--outfile=${outfile}`,
    ];
    const r = spawnSync(bun.host, args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (r.status !== 0)
      fail(`bun build failed for ${t.dir}/${name} (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    const mb = (statSync(outfile).size / 1048576).toFixed(1);
    console.log(`built ${t.dir}/${name}${t.ext} ${mb} MB`);
  }
}
