// Compiles the hook, statusline and subagents Node bundles (dist/*.mjs, from build.mjs) into
// single-file Bun executables (A15 fallback for R1.1; Linux x64 for WSL2, R1.11):
//   dist/exe/windows-x64/{hook,statusline,subagents}.exe
//   dist/exe/linux-x64/{hook,statusline,subagents}
// plus bun-floor (a hello-world exe, the startup floor for the benches) in each directory.
// Usage: node scripts/build-exe.mjs [--no-bytecode]   (run `pnpm build` first)
// Bun is a build tool only (MIT); no code is copied. The exe never autoloads .env or bunfig.toml
// from the cwd (Claude Code runs hooks with cwd = the user's project).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..").replaceAll("\\", "/");
const useBytecode = !process.argv.includes("--no-bytecode");

function fail(message) {
  console.error(`build-exe: ${message}`);
  process.exit(1);
}

function resolveBun() {
  try {
    const fromProbe = createRequire(join(root, "package.json"));
    const bunPkg = fromProbe.resolve("bun/package.json");
    const bunDir = dirname(bunPkg);
    const fromBun = createRequire(bunPkg);
    const linuxPkg = fromBun.resolve("@oven/bun-linux-x64/package.json");
    return {
      windows: join(bunDir, "bin", "bun.exe").replaceAll("\\", "/"),
      linuxBase: join(dirname(linuxPkg), "bin", "bun").replaceAll("\\", "/"),
    };
  } catch (err) {
    return fail(
      `cannot resolve the pinned bun packages (bun, @oven/bun-linux-x64): ${err.message}. Run pnpm install.`,
    );
  }
}

const bun = resolveBun();
for (const [label, p] of [
  ["bun.exe", bun.windows],
  ["linux x64 base", bun.linuxBase],
]) {
  if (!existsSync(p))
    fail(`${label} not found at ${p}; run pnpm install (postinstall fetches the binary)`);
}

const targets = [
  { dir: "windows-x64", ext: ".exe", args: [] },
  {
    dir: "linux-x64",
    ext: "",
    args: ["--target=bun-linux-x64", `--compile-executable-path=${bun.linuxBase}`],
  },
];
const programs = [
  ["hook", `${root}/dist/hook.mjs`],
  ["statusline", `${root}/dist/statusline.mjs`],
  ["subagents", `${root}/dist/subagents.mjs`],
  ["bun-floor", `${root}/scripts/bun-floor.mjs`],
];

for (const t of targets) {
  const outDir = `${root}/dist/exe/${t.dir}`;
  mkdirSync(outDir, { recursive: true });
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
    const r = spawnSync(bun.windows, args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (r.status !== 0)
      fail(`bun build failed for ${t.dir}/${name} (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    const mb = (statSync(outfile).size / 1048576).toFixed(1);
    console.log(`built ${t.dir}/${name}${t.ext} ${mb} MB`);
  }
}
