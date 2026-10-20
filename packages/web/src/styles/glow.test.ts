import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R3.6: a repainting animation on a card that the board moves costs frames at 20 deltas/s.
describe("attention glow is compositor-only", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");
  it("sd-glow keyframes change opacity and nothing else", () => {
    const m = /@keyframes sd-glow \{([\s\S]*?)\n\}\n/.exec(css);
    expect(m).not.toBeNull();
    const props = [...m![1]!.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]);
    expect(new Set(props)).toEqual(new Set(["opacity"]));
  });
  it("the glow layer never takes pointer events and only animates under sd-arrive", () => {
    expect(css).toMatch(/\.sd-attention::after \{[^}]*pointer-events: none;[^}]*opacity: 0;/);
    expect(css).not.toMatch(/\.sd-attention::after \{[^}]*animation:/);
    expect(css).toMatch(/\.sd-attention\.sd-arrive::after \{\s*animation: sd-glow 400ms/);
  });
  it("the glow is off under prefers-reduced-motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*\.sd-attention\.sd-arrive::after \{\s*animation: none;/,
    );
  });
});
