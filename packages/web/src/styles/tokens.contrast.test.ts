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

// Ended and exited cards dim surface-only (.sd-dim: border and meter bars, never text opacity), so
// the surface-1 ratios below hold unchanged for those cards. SessionCard.test.tsx enforces it.
// Measured on --surface-1 only (design system rule). State-colored or faint TEXT must therefore
// sit on bg-surface-1, never on --bg or --surface-2; do not exempt any token from the 4.5:1 check.

describe("token contrast (R3.7)", () => {
  it("covers 10 tokens in 2 themes", () => {
    expect(rows).toHaveLength(20);
  });

  it("every state and meter token is >= 3:1 on surface-1 (icon)", () => {
    expect(rows.filter((r) => !r.icon).map(key)).toEqual([]);
  });

  it("every state, meter and fg text token passes 4.5:1 on surface-1, no exceptions", () => {
    const textTokenFails = (["dark", "light"] as const).flatMap((theme) =>
      (lib.TEXT_TOKENS as string[])
        .filter((n) => lib.contrast(tokens[theme][n], tokens[theme]["surface-1"]) < 4.5)
        .map((n) => `${theme} ${n} ${tokens[theme][n]}`),
    );
    const stateFails = rows.filter((r) => !r.text).map(key);
    expect([...stateFails, ...textTokenFails]).toEqual([]);
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

  it.each(["dark", "light"] as const)(
    "%s: border-control is >= 3:1 (non-text) on bg and surface-1..3",
    (theme) => {
      const t = tokens[theme];
      for (const s of ["bg", "surface-1", "surface-2", "surface-3"]) {
        expect(lib.contrast(t["border-control"], t[s]), s).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("math sanity: black on white is 21:1", () => {
    expect(lib.contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
