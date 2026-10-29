/**
 * Render-time neutralization of text that came from a vault capture (R5.3, security LOW).
 * Bidi overrides and isolates (U+202A-202E, U+2066-2069), zero-width and invisible format
 * characters, and C1 controls can reorder or hide text. They are made visible as `<U+XXXX>` so
 * the reader sees that something was there; nothing is dropped silently. React renders the result
 * as plain text; there is no HTML path.
 */

/** Inclusive code point ranges that are made visible. */
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008], // C0 controls (tab and newline kept)
  [0x000b, 0x001f], // C0 controls from VT up
  [0x007f, 0x007f], // DEL
  [0x0080, 0x009f], // C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // arabic letter mark
  [0x115f, 0x1160], // hangul choseong and jungseong fillers
  [0x180e, 0x180e], // mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, joiners, LRM, RLM
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x206f], // bidi isolates, deprecated format characters
  [0x3164, 0x3164], // hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
  [0xffa0, 0xffa0], // halfwidth hangul filler
  [0xfff9, 0xfffb], // interlinear annotation characters
  [0xe0000, 0xe007f], // tag characters
];

const cls = RANGES.map(([a, b]) => {
  const hex = (n: number) => `\\u{${n.toString(16)}}`;
  return a === b ? hex(a) : `${hex(a)}-${hex(b)}`;
}).join("");

const HIDDEN = new RegExp(`[${cls}]`, "gu");
const HIDDEN_ONE = new RegExp(`[${cls}]`, "u");

export function neutralize(text: string): string {
  return text.replace(
    HIDDEN,
    (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/** True when `neutralize` would change the text. */
export function hasHidden(text: string): boolean {
  return HIDDEN_ONE.test(text);
}
