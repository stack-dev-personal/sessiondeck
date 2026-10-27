// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R6.4: under prefers-reduced-motion a 0.01ms transition on every property fired thousands of
// transitionend events and an extra style/paint pass per live update.
describe("reduced motion collapses transitions without starting them", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? "";
  it("transition-duration is 0s (a zero-length transition never runs)", () => {
    expect(block).toMatch(/transition-duration:\s*0s\s*!important/);
    expect(block).not.toMatch(/transition-duration:\s*0\.01ms/);
  });
  it("animations keep a tiny duration so animationend handlers still fire", () => {
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});
