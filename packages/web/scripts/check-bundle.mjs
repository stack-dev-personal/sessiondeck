// Usage: node scripts/check-bundle.mjs <distDir> <mock|nomock>. Greps built JS for a golden-session id.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKER = "fef17e22-168c-4fef-8964-9af573b7f2e9";
const [dir = "dist", mode = "nomock"] = process.argv.slice(2);
const files = readdirSync(join(dir, "assets")).filter((f) => f.endsWith(".js"));
let total = 0;
let found = false;
for (const f of files) {
  const p = join(dir, "assets", f);
  total += statSync(p).size;
  if (readFileSync(p, "utf8").includes(MARKER)) found = true;
}
console.log(
  `${mode}: ${files.length} js files, ${total} bytes, fixture marker ${found ? "present" : "absent"}`,
);
if (mode === "nomock" && found) process.exit(1);
if (mode === "mock" && !found) process.exit(1);
