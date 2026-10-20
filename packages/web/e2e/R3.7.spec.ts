import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fullShot, gotoDevCards, openSettledBoard, setTheme, shot } from "./helpers";

interface Rec {
  specimen: string;
  kind: string;
  text: string;
  token: string;
  fg: string;
  bg: string;
  ratio: number;
}

/** In-page measurement: resolved colors, background composited up to the first opaque ancestor. */
async function measure(page: Page): Promise<{ recs: Rec[] }> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) throw new Error(`unparsed color ${c}`);
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      const ch = (i: number) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a;
      return [ch(0), ch(1), ch(2), a];
    };
    const lum = ([r, g, b]: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const background = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] === 1) break;
      }
      let acc: RGBA = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    const hex = (c: RGBA) =>
      "#" +
      c
        .slice(0, 3)
        .map((v) => Math.round(v!).toString(16).padStart(2, "0"))
        .join("");
    const tokenOf = (el: Element): string => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const t = Array.from(n.classList).find((c) =>
          /^text-(state-\w+|fg-faint|fg-muted|fg|meter-\w+)$/.test(c),
        );
        if (t) return t;
      }
      return "inherit";
    };
    const hasOwnText = (el: Element) =>
      Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");
    const groups: [string, string][] = [
      [
        "state",
        '[data-testid^="specimen-state-"] span[data-state] span, [data-testid^="specimen-state-"] [data-slot="state"], [data-testid^="specimen-state-"] [data-slot="state"] span',
      ],
      ["meter", '[data-slot="value"], [data-slot="cue"], [data-meter]'],
      ["faint", ".text-fg-faint"],
    ];
    const seen = new Set<Element>();
    const recs: Rec[] = [];
    for (const [kind, sel] of groups) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || !hasOwnText(el)) continue;
        if (
          kind === "meter" &&
          el.getAttribute("data-slot") === null &&
          el.children.length > 0 &&
          !hasOwnText(el)
        )
          continue;
        seen.add(el);
        const bg = background(el);
        const fgRaw = parse(getComputedStyle(el).color);
        const fg = over(fgRaw, bg);
        recs.push({
          specimen: el.closest("[data-testid^='specimen-']")?.getAttribute("data-testid") ?? "",
          kind,
          text: el.textContent!.trim().slice(0, 24),
          token: tokenOf(el),
          fg: hex(fg),
          bg: hex(bg),
          ratio: Math.round(ratio(fg, bg) * 100) / 100,
        });
      }
    }
    return { recs };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`R3.7 ${theme}: contrast of chips, glyphs, meter numbers, faint text`, async ({ page }) => {
    await setTheme(page, theme);
    await gotoDevCards(page);
    expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBe(theme);
    const { recs } = await measure(page);
    expect(recs.length).toBeGreaterThan(100);
    const kinds = new Set(recs.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["state", "meter", "faint"]));

    const failing = recs.filter((r) => r.ratio < 4.5);
    const failingTokens = [...new Set(failing.map((r) => r.token))].sort();
    console.log(
      `R3.7 ${theme} contrast failures (${failing.length} of ${recs.length} measured): ` +
        failingTokens
          .map((t) => {
            const r = failing.find((f) => f.token === t)!;
            return `${t} ${r.fg} on ${r.bg} = ${r.ratio}`;
          })
          .join("; "),
    );
    expect(failing, `text elements below 4.5:1 (${failingTokens.join(", ")})`).toEqual([]);
    writeFileSync(shot(`R3.7-contrast-${theme}.json`), JSON.stringify({ recs, failing }, null, 2));
    await fullShot(page, `R3.7-${theme}.png`, { baseline: theme === "light" });
  });

  test(`R3.7 ${theme}: axe on /board and /dev/cards`, async ({ page }) => {
    await setTheme(page, theme);
    const out: Record<string, unknown> = {};
    for (const path of ["/board", "/dev/cards"]) {
      if (path === "/board") {
        await openSettledBoard(page);
      } else {
        await gotoDevCards(page);
      }
      const results = await new AxeBuilder({ page }).analyze();
      out[path] = {
        violations: results.violations,
        incompleteIds: results.incomplete.map((i) => i.id),
        passes: results.passes.length,
      };
      if (path === "/board" && theme === "light") {
        await fullShot(page, "R3.7-board-light.png", { baseline: true });
      }
      const bad: string[] = [];
      for (const v of results.violations) {
        if (v.id === "color-contrast") {
          for (const n of v.nodes) {
            const fg = String((n.any[0]?.data as { fgColor?: string } | undefined)?.fgColor ?? "");
            bad.push(`color-contrast ${fg} ${n.target.join(" ")}`);
          }
        } else if (v.impact === "serious" || v.impact === "critical") {
          bad.push(`${v.id} (${v.impact}) x${v.nodes.length}`);
        }
      }
      const summary =
        results.violations.map((v) => `${v.id}:${v.nodes.length}`).join(", ") || "none";
      console.log(`R3.7 axe ${theme} ${path}: ${summary}`);
      expect(bad, `axe ${theme} ${path}`).toEqual([]);
    }
    writeFileSync(shot(`R3.7-axe-${theme}.json`), JSON.stringify(out, null, 2));
  });
}

test("R3.7 no color-only encoding: glyph, label and text cues are in the DOM", async ({ page }) => {
  await gotoDevCards(page);
  for (const [state, glyph, label] of [
    ["working", "●", "Working"],
    ["error", "✖", "Error"],
    ["ended", "■", "Ended"],
  ] as const) {
    const chip = page.getByTestId(`specimen-state-${state}`).locator("span[data-state]");
    expect((await chip.locator("span").first().textContent())?.trim()).toBe(glyph);
    await expect(chip).toContainText(label);
  }
  const all = await page
    .locator('[data-testid^="specimen-state-"]:not([data-testid$="-compact"])')
    .count();
  expect(all).toBe(8);
  const states = await page
    .locator('[data-testid^="specimen-state-"] span[data-state]')
    .evaluateAll((els) =>
      els.map((e) => ({
        glyph: e.querySelector("span")?.textContent?.trim() ?? "",
        text: (e.textContent ?? "").replace(e.querySelector("span")?.textContent ?? "", "").trim(),
      })),
    );
  for (const s of states) {
    expect(s.glyph).not.toBe("");
    expect(s.text).not.toBe("");
  }
  const meters = await page
    .locator('[data-meter][data-level="warn"], [data-meter][data-level="high"]')
    .evaluateAll((els) =>
      els.map((e) => ({
        level: e.getAttribute("data-level"),
        text: (e.textContent ?? "").replace(/\s+/g, ""),
        aria: e.getAttribute("aria-label") ?? "",
      })),
    );
  expect(meters.length).toBe(9); // ctx 60, 80, 81; 5h and 7d 60, 85, 86
  for (const m of meters) {
    expect(m.text).toMatch(m.level === "high" ? /!!$/ : /!$/);
    expect(m.text).toMatch(/\d+%/);
    expect(m.aria).toMatch(m.level === "high" ? /high/ : /warning/);
  }
});
