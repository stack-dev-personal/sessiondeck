import { describe, expect, it } from "vitest";
import { hasHidden, neutralize } from "./neutralize";

const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));

describe("neutralize", () => {
  it("makes every bidi override and isolate visible", () => {
    for (const c of [...range(0x202a, 0x202e), ...range(0x2066, 0x2069)]) {
      const out = neutralize(`a${c}b`);
      expect(out).toMatch(/^a<U\+[0-9A-F]{4}>b$/);
      expect(out).not.toContain(c);
    }
    expect(neutralize(`ok ${ch(0x202e)}evil${ch(0x202c)}`)).toBe("ok <U+202E>evil<U+202C>");
  });

  it("covers zero-width characters, BOM, and C1 controls", () => {
    expect(
      neutralize(`a${ch(0x200b)}b${ch(0x200c)}c${ch(0x200d)}d${ch(0x2060)}e${ch(0xfeff)}`),
    ).toBe("a<U+200B>b<U+200C>c<U+200D>d<U+2060>e<U+FEFF>");
    for (const c of range(0x80, 0x9f))
      expect(neutralize(`x${c}y`)).toMatch(/^x<U\+00[89][0-9A-F]>y$/);
  });

  it("covers DEL, C0 controls, fillers, variation selectors and tag characters", () => {
    expect(neutralize(`a${ch(0x7f)}b`)).toBe("a<U+007F>b");
    expect(neutralize(`a${ch(0x1)}b`)).toBe("a<U+0001>b");
    expect(neutralize(`a${ch(0xe0041)}b`)).toBe("a<U+E0041>b");
    expect(neutralize(`a${ch(0xfe0f)}${ch(0x3164)}${ch(0x115f)}${ch(0xffa0)}b`)).toBe(
      "a<U+FE0F><U+3164><U+115F><U+FFA0>b",
    );
  });

  it("leaves ordinary text, newlines, tabs and non-latin letters alone", () => {
    const s = "Spool compaction\n\tdone: café 日本語 🙂 -- RTL مرحبا";
    expect(neutralize(s)).toBe(s);
    expect(hasHidden(s)).toBe(false);
  });

  it("hasHidden agrees on repeated calls", () => {
    expect(hasHidden(`a${ch(0x202e)}b`)).toBe(true);
    expect(hasHidden(`a${ch(0x202e)}b`)).toBe(true);
  });
});
