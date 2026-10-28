/** Design-token names the hub accepts for a project color (packages/hub/src/routes/atlas.ts COLOR_TOKENS). */
export const COLOR_TOKENS = [
  "accent",
  "accent-attention",
  "state-starting",
  "state-working",
  "state-waiting",
  "state-idle",
  "state-error",
  "state-ended",
  "state-exited",
  "meter-ok",
  "meter-warn",
  "meter-high",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;
const TOKENS: ReadonlySet<string> = new Set(COLOR_TOKENS);

export function isColorToken(v: string): v is ColorToken {
  return TOKENS.has(v);
}

/** True for a value the hub would accept: an allow-listed token name or `#rrggbb`. */
export function isValidColor(v: string): boolean {
  return HEX.test(v) || TOKENS.has(v);
}

/**
 * CSS value for a project color, or null when it is neither an allow-listed token nor a valid
 * #rrggbb. Nothing else from the hub ever reaches a style attribute.
 */
export function cssColor(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  if (TOKENS.has(v)) return `var(--${v})`;
  return HEX.test(v) ? v : null;
}
