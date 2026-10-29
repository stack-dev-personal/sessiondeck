// R4.7 false-positive check on real code: every line of packages/*/src/**/*.ts (the repo's own
// TypeScript, which is full of `token`, `password` and `key` identifiers) goes through the
// redactor as a tool_result string. Prints each changed line; the budget is a hard ceiling.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../../src/redaction/redactor.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const red = createRedactor();

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("false positives on the repo's own source", () => {
  it("lists every changed line of packages/*/src/**/*.ts", () => {
    const files: string[] = [];
    for (const pkg of readdirSync(join(root, "packages"))) {
      const src = join(root, "packages", pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, files);
      } catch {
        /* package without src */
      }
    }
    let lines = 0;
    const changed: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((l, i) => {
          lines += 1;
          const row = JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", content: l }] },
          });
          if (red.redactLine(row) !== row)
            changed.push(`${relative(root, f)}:${i + 1}: ${l.trim().slice(0, 110)}`);
        });
    }
    console.log(
      `repo source: ${files.length} files, ${lines} lines, ${changed.length} changed\n` +
        changed.map((c) => `  ${c}`).join("\n"),
    );
    expect(changed.length).toBeLessThanOrEqual(Math.ceil(lines * 0.002));
  });
});
