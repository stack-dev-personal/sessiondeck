import { TEXT_TOKENS, report, parseTokens, contrast, TEXT_MIN, ICON_MIN } from "./contrast-lib.mjs";

const rows = report();
const pad = (s, n) => String(s).padEnd(n);
console.log(`WCAG 2.x contrast against --surface-1 (text >= ${TEXT_MIN}, icon >= ${ICON_MIN})`);
console.log(
  `${pad("theme", 6)}${pad("token", 16)}${pad("value", 9)}${pad("ratio", 8)}${pad("text", 6)}icon`,
);
for (const r of rows) {
  console.log(
    `${pad(r.theme, 6)}${pad(r.token, 16)}${pad(r.value, 9)}${pad(r.ratio.toFixed(2), 8)}${pad(r.text ? "pass" : "FAIL", 6)}${r.icon ? "pass" : "FAIL"}`,
  );
}
const tokens = parseTokens();
console.log(
  "\nNote: ended/exited cards dim the surface only (border, meter bars); text keeps full opacity, so the ratios above apply to them unchanged.",
);
console.log("\nOther pairs");
for (const theme of ["dark", "light"]) {
  const t = tokens[theme];
  for (const name of TEXT_TOKENS) {
    const ratio = contrast(t[name], t["surface-1"]);
    console.log(
      `${pad(theme, 6)}${pad(name + " / surface-1", 28)}${ratio.toFixed(2)}  ${ratio >= TEXT_MIN ? "pass" : "FAIL"}`,
    );
  }
  for (const surf of ["bg", "surface-1", "surface-2", "surface-3"]) {
    const ratio = contrast(t["border-control"], t[surf]);
    console.log(
      `${pad(theme, 6)}${pad("border-control / " + surf, 28)}${ratio.toFixed(2)}  ${ratio >= ICON_MIN ? "pass" : "FAIL"} (non-text)`,
    );
  }
  for (const name of ["meter-ok", "meter-warn", "meter-high"]) {
    const ratio = contrast(t[name], t["meter-track"]);
    console.log(
      `${pad(theme, 6)}${pad(name + " / meter-track", 28)}${ratio.toFixed(2)}  ${ratio >= ICON_MIN ? "pass" : "FAIL"}`,
    );
  }
}
const textFails = rows
  .filter((r) => !r.text)
  .map((r) => `${r.theme} ${r.token} ${r.value} ${r.ratio.toFixed(2)}`);
for (const theme of ["dark", "light"]) {
  for (const name of TEXT_TOKENS) {
    const ratio = contrast(tokens[theme][name], tokens[theme]["surface-1"]);
    if (ratio < TEXT_MIN)
      textFails.push(`${theme} ${name} ${tokens[theme][name]} ${ratio.toFixed(2)}`);
  }
}
console.log(`\nText failures (${textFails.length}):\n  ${textFails.join("\n  ") || "none"}`);
