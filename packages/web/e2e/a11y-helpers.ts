import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Store handles the mock build exposes on window (src/main.tsx, VITE_MOCK only). */
export interface SdHandles {
  board: {
    getState: () => {
      sessions: Record<string, { session_id: string; state: string; last_event_at?: string }>;
    };
    setState: (p: unknown) => void;
  };
  ui: { getState: () => unknown };
}

export type Connection = "mock" | "connecting" | "open" | "closed" | "invalid";

/** Drives the connection status the banner and header read. retryInMs sets a reconnect deadline. */
export async function setConnection(
  page: Page,
  connection: Connection,
  retryInMs: number | null = null,
): Promise<void> {
  await page.evaluate(
    ([c, r]) => {
      const sd = (window as unknown as { __sd: { board: { getState: () => unknown } } }).__sd;
      (
        sd.board.getState() as { setConnection: (c: string, r: number | null) => void }
      ).setConnection(c as string, r === null ? null : Date.now() + (r as number));
    },
    [connection, retryInMs] as const,
  );
}

export interface TextRec {
  text: string;
  tag: string;
  fg: string;
  bg: string;
  ratio: number;
  disabled: boolean;
}

/** Computed contrast of every visible text-bearing element (and select/input values) on the page. */
export async function measureAllText(page: Page): Promise<TextRec[]> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) {
        // color-mix and friends resolve to color(srgb ...) in Chromium
        const s = /color\(srgb ([^)]+)\)/.exec(c);
        if (!s) throw new Error(`unparsed color ${c}`);
        const p = s[1]!.split(/[ /]+/).filter(Boolean).map(Number);
        return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1];
      }
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (t: RGBA, u: RGBA): RGBA => {
      const a = t[3] + u[3] * (1 - t[3]);
      const ch = (i: number) => (t[i]! * t[3] + u[i]! * u[3] * (1 - t[3])) / a;
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
    const bgOf = (el: Element): RGBA => {
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
        .map((v) => Math.round(v).toString(16).padStart(2, "0"))
        .join("");
    const recs: TextRec[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // sr-only
      if (el.closest("[aria-hidden='true']")) continue; // decorative glyphs carry no information alone
      const own = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent!.trim() !== "",
      );
      const control = el.tagName === "SELECT" || el.tagName === "INPUT";
      if (!own && !control) continue;
      if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)) continue;
      if (el instanceof HTMLInputElement && el.value === "" && el.placeholder === "") continue;
      const bg = bgOf(el);
      const fg = over(parse(cs.color), bg);
      recs.push({
        text: (el.textContent || (el as HTMLInputElement).value || "").trim().slice(0, 32),
        tag: el.tagName.toLowerCase(),
        fg: hex(fg),
        bg: hex(bg),
        ratio: Math.round(ratio(fg, bg) * 100) / 100,
        disabled: (el as HTMLButtonElement).disabled === true,
      });
    }
    return recs;
  });
}

/** Ratio of two CSS custom properties as currently resolved (theme-aware). */
export async function tokenRatio(page: Page, fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const rgb = (v: string): [number, number, number] => {
        const d = document.createElement("div");
        d.style.color = `var(${v})`;
        document.body.appendChild(d);
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(d).color)!;
        d.remove();
        const p = m[1]!.split(/[ ,/]+/).map(Number);
        return [p[0]!, p[1]!, p[2]!];
      };
      const L = (c: [number, number, number]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const [hi, lo] = [L(rgb(a!)), L(rgb(b!))].sort((x, y) => y - x);
      return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
    },
    [fg, bg],
  );
}

/** Runs axe with the WCAG 2.1 A/AA tag set; returns violation summaries (empty when clean). */
export async function axeViolations(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = results.violations.map(
    (v) => `${label}: ${v.id} (${v.impact}) x${v.nodes.length} ${v.nodes[0]?.target.join(" ")}`,
  );
  console.log(`axe ${label}: ${bad.length === 0 ? "none" : bad.join(" | ")}`);
  return bad;
}

export function expectAllReadable(recs: TextRec[], label: string): void {
  expect(recs.length, `${label}: measured text elements`).toBeGreaterThan(8);
  const failing = recs.filter((r) => !r.disabled && r.ratio < 4.5);
  expect(
    failing.map((f) => `${f.tag} "${f.text}" ${f.fg} on ${f.bg} = ${f.ratio}`),
    `${label}: text below 4.5:1`,
  ).toEqual([]);
}

/** 1.4.11: enabled text inputs, selects and buttons need a 3:1 boundary against what surrounds them. */
export async function measureControlBorders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rgb = (c: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(c)!;
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const surround = (el: Element): number[] => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c[3] === 1) return c;
      }
      return [255, 255, 255, 1];
    };
    const out: string[] = [];
    const sel = "select, input:not([type=checkbox]):not([type=radio]), button:not(:disabled)";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.borderTopWidth) === 0) continue;
      const [hi, lo] = [lum(rgb(cs.borderTopColor)), lum(surround(el))].sort((a, b) => b - a);
      const ratio = (hi! + 0.05) / (lo! + 0.05);
      if (ratio < 3) {
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent || el.id).trim().slice(0, 20)}" ${ratio.toFixed(2)}`,
        );
      }
    }
    return out;
  });
}
