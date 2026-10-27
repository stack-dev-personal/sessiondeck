// Shared by bench-hook.mjs and bench-statusline.mjs: maps `--target node|exe|bun-floor` to a command.
//   node      node dist/<name>.mjs        (default)
//   exe       dist/exe/<platform>-x64/<name>[.exe]   (build with `pnpm build:exe`)
//   bun-floor dist/exe/<platform>-x64/bun-floor[.exe] (compiled hello-world, the startup floor)
import { existsSync } from "node:fs";
import { join } from "node:path";

export function parseTarget(argv) {
  const i = argv.indexOf("--target");
  const target = i >= 0 ? argv[i + 1] : "node";
  if (!["node", "exe", "bun-floor"].includes(target)) {
    console.error(`unknown --target ${target}; use node, exe or bun-floor`);
    process.exit(2);
  }
  return target;
}

/** Returns { cmd, prefix } so the bench runs spawnSync(cmd, [...prefix, ...probeArgs]). */
export function resolveCommand(root, name, target) {
  if (target === "node")
    return { cmd: process.execPath, prefix: [join(root, "dist", `${name}.mjs`)] };
  const dir = join(root, "dist", "exe", process.platform === "win32" ? "windows-x64" : "linux-x64");
  const file =
    (target === "bun-floor" ? "bun-floor" : name) + (process.platform === "win32" ? ".exe" : "");
  const cmd = join(dir, file);
  if (!existsSync(cmd)) {
    console.error(`${cmd} not found; run pnpm build && pnpm build:exe`);
    process.exit(2);
  }
  return { cmd, prefix: [] };
}
