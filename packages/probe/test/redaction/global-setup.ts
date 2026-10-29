// Generates the redaction corpora into test/redaction/.generated/ (gitignored) before any test runs.
// The corpora hold provider-format tokens; those are assembled at run time and never committed (GH013).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const gen of ["gen-corpus.mjs", "gen-independent.mjs", "gen-fresh.mjs"]) {
    execFileSync(process.execPath, [join(here, gen)], {
      cwd: here,
      stdio: "pipe",
      windowsHide: true,
    });
  }
}
