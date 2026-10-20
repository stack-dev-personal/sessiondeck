import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}
