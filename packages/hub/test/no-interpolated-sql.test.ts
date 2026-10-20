import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe("sql hygiene", () => {
  it("no template literal with ${} passed to prepare/exec/pragma", () => {
    const src = path.join(import.meta.dirname, "..", "src");
    for (const f of walk(src).filter((p) => p.endsWith(".ts"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\.(prepare|exec|pragma)\(\s*`[^`]*\$\{/);
    }
  });
});
