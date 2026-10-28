// Usage: node scripts/check-bundle.mjs <distDir> <mock|nomock>. Greps built JS for the golden-session
// id (fixture data) and for the mock-only `window.__sd` test hook (src/main.tsx).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "fef17e22-168c-4fef-8964-9af573b7f2e9";
export const HOOK = "__sd";
/** Marker string of the atlas mock (src/mock/atlas.ts); must not ship in real builds. */
export const ATLAS_MOCK = "sd-mock-atlas-v1";

/** Pure: returns the list of problems for a mode given the bundle text. Empty means pass. */
export function problems(text, mode) {
  const marker = text.includes(MARKER);
  const hook = text.includes(HOOK);
  const out = [];
  if (mode === "nomock") {
    if (marker) out.push("fixture marker present in nomock bundle");
    if (hook) out.push(`${HOOK} test hook present in nomock bundle`);
    if (text.includes(ATLAS_MOCK)) out.push("atlas mock marker present in nomock bundle");
  }
  if (mode === "mock" && !marker) out.push("fixture marker absent from mock bundle");
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir = "dist", mode = "nomock"] = process.argv.slice(2);
  const files = readdirSync(join(dir, "assets")).filter((f) => f.endsWith(".js"));
  let total = 0;
  let text = "";
  for (const f of files) {
    const p = join(dir, "assets", f);
    total += statSync(p).size;
    text += readFileSync(p, "utf8");
  }
  const bad = problems(text, mode);
  console.log(
    `${mode}: ${files.length} js files, ${total} bytes, fixture marker ${text.includes(MARKER) ? "present" : "absent"}, ${HOOK} ${text.includes(HOOK) ? "present" : "absent"}`,
  );
  for (const b of bad) console.error(`FAIL: ${b}`);
  if (bad.length > 0) process.exit(1);
}
