import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper shared with scripts/contrast-report.mjs
import * as lib from "../../scripts/contrast-lib.mjs";

interface Row {
  theme: "dark" | "light";
  token: string;
  value: string;
  ratio: number;
  text: boolean;
  icon: boolean;
}
const rows: Row[] = lib.report();
const tokens: Record<"dark" | "light", Record<string, string>> = lib.parseTokens();
const key = (r: Row) => `${r.theme} ${r.token} ${r.value}`;

/** Known text-contrast failures pending a user decision. Fixing one (or adding one) flips a test. */
const KNOWN_TEXT_FAILURES = ["dark state-ended #6e7681", "light state-starting #8c959f"];

describe("token contrast (R3.7)", () => {
  it("covers 10 tokens in 2 themes", () => {
    expect(rows).toHaveLength(20);
  });

  it("every state and meter token is >= 3:1 on surface-1 (icon)", () => {
    expect(rows.filter((r) => !r.icon).map(key)).toEqual([]);
  });

  it("text failures (< 4.5:1) are exactly the two known ones", () => {
    expect(
      rows
        .filter((r) => !r.text)
        .map(key)
        .sort(),
    ).toEqual([...KNOWN_TEXT_FAILURES].sort());
  });

  it("known failures are near their documented ratios", () => {
    const get = (theme: string, token: string) =>
      rows.find((r) => r.theme === theme && r.token === token)!;
    expect(get("dark", "state-ended").ratio).toBeCloseTo(3.8, 1);
    expect(get("light", "state-starting").ratio).toBeCloseTo(3.04, 1);
  });

  it.each(["dark", "light"] as const)("%s: fg and fg-muted pass 4.5:1 on surface-1", (theme) => {
    for (const name of ["fg", "fg-muted"]) {
      const t = tokens[theme];
      expect(lib.contrast(t[name], t["surface-1"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["dark", "light"] as const)("%s: meter fills pass 3:1 on meter-track", (theme) => {
    const t = tokens[theme];
    for (const name of ["meter-ok", "meter-warn", "meter-high"]) {
      expect(lib.contrast(t[name], t["meter-track"])).toBeGreaterThanOrEqual(3);
    }
  });

  it("math sanity: black on white is 21:1", () => {
    expect(lib.contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
