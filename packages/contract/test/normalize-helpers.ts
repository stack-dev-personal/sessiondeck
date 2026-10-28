import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizeOptions } from "../src/normalize";
import { parseJsonl } from "../src/normalize";

export const TRANSCRIPTS_DIR = join(import.meta.dirname, "..", "fixtures", "transcripts");
export const GOLDEN_DIR = join(import.meta.dirname, "golden", "normalize");

export interface TranscriptFixture {
  name: string;
  main: unknown[];
  subagents: Record<string, unknown[]>;
  meta: Record<string, { toolUseId?: string; agentType?: string; description?: string }>;
}

export function fixtureNames(): string[] {
  return readdirSync(TRANSCRIPTS_DIR)
    .filter((d) => /^\d\d-/.test(d))
    .sort();
}

export function loadTranscript(name: string): TranscriptFixture {
  const dir = join(TRANSCRIPTS_DIR, name);
  const main = parseJsonl(readFileSync(join(dir, "session.jsonl"), "utf8"));
  const subagents: TranscriptFixture["subagents"] = {};
  const meta: TranscriptFixture["meta"] = {};
  const sdir = join(dir, "subagents");
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir).sort()) {
      const m = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(f);
      if (!m?.[1]) continue;
      const text = readFileSync(join(sdir, f), "utf8");
      if (m[2] === "jsonl") subagents[m[1]] = parseJsonl(text);
      else meta[m[1]] = JSON.parse(text) as TranscriptFixture["meta"][string];
    }
  }
  return { name, main, subagents, meta };
}

export function optionsOf(fx: TranscriptFixture): NormalizeOptions {
  return { subagents: fx.subagents, subagentMeta: fx.meta };
}

/** One message per line keeps golden diffs reviewable. */
export function goldenText(messages: readonly unknown[]): string {
  return `[\n${messages.map((m) => JSON.stringify(m)).join(",\n")}\n]\n`;
}
