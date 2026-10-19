/* Derives the "observed payloads" table from the committed, scrubbed fixtures (never from raw/). */
import { loadFixtures } from "./helpers";

export interface ObservedRow {
  event: string;
  fixtures: number;
  fields: string[];
}

/** One row per fixture directory: file count and the sorted union of top-level payload keys. */
export function observedRows(): ObservedRow[] {
  const byEvent = new Map<string, { count: number; keys: Set<string> }>();
  for (const fx of loadFixtures()) {
    const entry = byEvent.get(fx.dir) ?? { count: 0, keys: new Set<string>() };
    entry.count += 1;
    if (typeof fx.payload === "object" && fx.payload !== null) {
      for (const key of Object.keys(fx.payload)) entry.keys.add(key);
    }
    byEvent.set(fx.dir, entry);
  }
  return [...byEvent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([event, e]) => ({ event, fixtures: e.count, fields: [...e.keys].sort() }));
}

export function renderObservedTable(rows: readonly ObservedRow[]): string {
  const lines = ["| Event | Fixtures | Top-level fields |", "| --- | --- | --- |"];
  for (const r of rows) {
    lines.push(`| ${r.event} | ${r.fixtures} | ${r.fields.map((f) => `\`${f}\``).join(" ")} |`);
  }
  return lines.join("\n");
}
