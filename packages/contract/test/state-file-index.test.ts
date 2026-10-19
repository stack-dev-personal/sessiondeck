import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// node:fs must not reach the web bundle, so index.ts may never pull in the state-file modules.
describe("index.ts and the state-file subpath", () => {
  it("does not import or re-export state-file", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/state-file/);
  });

  it("is a separate package export", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { exports: Record<string, string> };
    expect(manifest.exports["./state-file"]).toBe("./src/state-file.ts");
  });
});
