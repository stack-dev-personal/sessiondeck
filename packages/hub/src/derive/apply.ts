// R2.12. Writes transcript-derived figures into a snapshot without ever displacing a statusline
// value. Every function returns the same object when nothing changes and never mutates its input.
import { mergeSource, type SessionSnapshot, type SnapshotSources } from "@sessiondeck/contract";
import type { TranscriptFigures } from "./figures.ts";

/**
 * Cap of last_assistant_message. The contract applies it in its Stop reducer (limits.ts, not
 * exported from the package), so the value and the truncation are mirrored here and
 * test/transcript-figures-unit.test.ts proves both equal the contract's output.
 */
export const LAST_MESSAGE_MAX_CHARS = 2000;
const TRUNCATION_MARKER = "...[truncated]";

export function truncateMessage(text: string): string {
  const max = LAST_MESSAGE_MAX_CHARS;
  if (text.length <= max) return text;
  let cut = max - TRUNCATION_MARKER.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}${TRUNCATION_MARKER}`;
}

const sameSource = (s: SnapshotSources | undefined, key: keyof SnapshotSources): boolean =>
  s?.[key] === "transcript";

/** Fills fields no statusline value owns. Sources are set only for fields that were filled. */
export function applyFigures(snap: SessionSnapshot, f: TranscriptFigures): SessionSnapshot {
  let s = snap;
  const src = (): SnapshotSources | undefined => s.sources;
  const free = (key: keyof SnapshotSources): boolean => src()?.[key] !== "statusline";
  const mark = (key: keyof SnapshotSources): SnapshotSources =>
    mergeSource(src(), key, "transcript");

  if (f.model !== null && free("model")) {
    if (s.model?.id !== f.model || !sameSource(src(), "model")) {
      s = { ...s, model: { id: f.model, display_name: f.model }, sources: mark("model") };
    }
  }
  // Tokens without a window: the pricing table's public API does not expose max_input_tokens, so
  // the percent stays null rather than guessing a window.
  if (f.contextTokens !== null && free("context")) {
    const c = s.context;
    const same =
      c.input === f.contextTokens && c.used_pct === null && c.window === null && c.output === null;
    if (!same || !sameSource(src(), "context")) {
      s = {
        ...s,
        context: { used_pct: null, window: null, input: f.contextTokens, output: null },
        sources: mark("context"),
      };
    }
  }
  if (f.branch !== null && free("git_branch")) {
    if (s.git.branch !== f.branch || !sameSource(src(), "git_branch")) {
      s = { ...s, git: { ...s.git, branch: f.branch }, sources: mark("git_branch") };
    }
  }
  if (f.message !== null && free("last_assistant_message")) {
    const text = truncateMessage(f.message);
    if (s.last_assistant_message !== text || !sameSource(src(), "last_assistant_message")) {
      s = { ...s, last_assistant_message: text, sources: mark("last_assistant_message") };
    }
  }
  return s;
}

/** Transcript-priced lifetime cost into cost.usd, unless the statusline owns it. */
export function applyCost(snap: SessionSnapshot, usd: number): SessionSnapshot {
  if (snap.sources?.cost === "statusline") return snap;
  if (snap.cost.usd === usd && snap.sources?.cost === "transcript") return snap;
  return {
    ...snap,
    cost: { ...snap.cost, usd },
    sources: mergeSource(snap.sources, "cost", "transcript"),
  };
}

/**
 * A hook (SessionStart model, Stop last_assistant_message) must not displace a value the
 * transcript filled, or live ingest and a replay (events first, transcript last) would disagree.
 */
export function keepTranscriptFigures(
  prev: SessionSnapshot,
  next: SessionSnapshot,
): SessionSnapshot {
  let s = next;
  if (prev.sources?.model === "transcript" && s.model !== prev.model) {
    s = { ...s, model: prev.model };
  }
  if (
    prev.sources?.last_assistant_message === "transcript" &&
    s.last_assistant_message !== prev.last_assistant_message
  ) {
    s = { ...s, last_assistant_message: prev.last_assistant_message };
  }
  return s;
}
