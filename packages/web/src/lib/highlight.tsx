import type { ReactNode } from "react";

/** The query's search tokens: runs of letters and digits, lower-cased (same split the hub uses). */
export function queryTokens(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
}

/** Merged [start, end) ranges of `text` where a token occurs (case-insensitive). No regex, so no injection. */
export function matchRanges(text: string, tokens: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  // toLowerCase can change the length for a few characters; offsets would then be wrong, so skip.
  if (lower.length !== text.length) return [];
  const raw: Array<[number, number]> = [];
  for (const t of tokens) {
    if (t === "") continue;
    let i = lower.indexOf(t);
    while (i !== -1) {
      raw.push([i, i + t.length]);
      i = lower.indexOf(t, i + t.length);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * `text` as React nodes with the matched ranges wrapped in <mark>. The text is only ever placed in
 * text nodes (React escapes it); nothing here builds HTML. Transcript text is hostile input.
 */
export function Highlighted({
  text,
  tokens,
}: {
  text: string;
  tokens: readonly string[];
}): ReactNode {
  const ranges = matchRanges(text, tokens);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark key={i} className="bg-transparent font-semibold text-fg underline">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
