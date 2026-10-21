// WCAG 2.x contrast math and a tokens.css parser. Shared by the test and the report script.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOKENS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "styles",
  "tokens.css",
);

/** Returns { dark: {name: value}, light: {name: value} } where light overrides dark. */
export function parseTokens(css = readFileSync(TOKENS_PATH, "utf8")) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const dark = {};
  const lightOnly = {};
  for (const [, selector, body] of blocks) {
    const target = selector.includes('data-theme="light"') ? lightOnly : dark;
    for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      target[name] = value.trim();
    }
  }
  return { dark, light: { ...dark, ...lightOnly } };
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const STATE_TOKENS = [
  "state-starting",
  "state-working",
  "state-waiting",
  "state-idle",
  "state-error",
  "state-ended",
  "state-exited",
];
export const METER_TOKENS = ["meter-ok", "meter-warn", "meter-high"];
export const TEXT_MIN = 4.5;
export const ICON_MIN = 3;

/** Every state and meter token against surface-1 in both themes. */
export function report(tokens = parseTokens()) {
  const rows = [];
  for (const theme of ["dark", "light"]) {
    const t = tokens[theme];
    for (const name of [...STATE_TOKENS, ...METER_TOKENS]) {
      const ratio = contrast(t[name], t["surface-1"]);
      rows.push({
        theme,
        token: name,
        value: t[name],
        ratio,
        text: ratio >= TEXT_MIN,
        icon: ratio >= ICON_MIN,
      });
    }
  }
  return rows;
}

/** Text tokens (not states) that must also be readable on surface-1. fg-faint is a known failure. */
export const TEXT_TOKENS = ["fg", "fg-muted", "fg-faint"];
