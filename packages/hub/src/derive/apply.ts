// R2.12. Writes transcript-derived figures into a snapshot without ever displacing a statusline
// value. Every function returns the same object when nothing changes and never mutates its input.
import {
  mergeSource,
  type SessionSnapshot,
  type SnapshotSources,
  type SubagentSnapshot,
} from "@sessiondeck/contract";
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

/** A subagent row whose figures a subagentStatusLine (or any non-transcript source) owns. */
function ownedElsewhere(row: SubagentSnapshot): boolean {
  if (row.figures_source === "subagent_statusline") return true;
  if (row.figures_source === "transcript") return false;
  // No source yet: a non-null figure can only have come from a statusline written before sources existed.
  return row.model !== null || row.tokens !== null || row.context_window !== null;
}

/**
 * R2.13. Fills one subagent row's model and tokens from its transcript figures (tokens = last
 * assistant row's input + cache_creation + cache_read, the same meaning as the subagentStatusLine
 * tokenCount). context_window stays as it is: the pricing table's public API does not expose
 * max_input_tokens and no window is hard-coded. effort is set only when the subagent's own
 * assistant rows state a string `effort` (decision 28: measured, never estimated); the SubagentStop
 * hook's effort.level is a session-wide field and is not used here. A row with no
 * matching agent_id is ignored, never created; a statusline-owned row is never touched.
 */
export function applySubagentFigures(
  snap: SessionSnapshot,
  agentId: string,
  f: TranscriptFigures,
): SessionSnapshot {
  if (f.model === null && f.contextTokens === null && f.effort === null) return snap;
  const idx = snap.subagents.findIndex((r) => r.agent_id === agentId);
  const row = snap.subagents[idx];
  if (row === undefined || ownedElsewhere(row)) return snap;
  if (
    row.model === f.model &&
    row.tokens === f.contextTokens &&
    (row.effort ?? null) === f.effort &&
    row.figures_source === "transcript"
  ) {
    return snap;
  }
  // effort is written only when the transcript states it; the key stays absent otherwise so a
  // replayed row and a live row serialize identically.
  const { effort: _prior, ...rest } = row;
  void _prior;
  const next: SubagentSnapshot = {
    ...rest,
    model: f.model,
    tokens: f.contextTokens,
    ...(f.effort !== null ? { effort: f.effort } : {}),
    figures_source: "transcript",
  };
  return { ...snap, subagents: snap.subagents.map((r, i) => (i === idx ? next : r)) };
}

/** True when a subagent row has no figure source yet, so a derive attempt may fill it. */
export function needsSubagentFigures(row: SubagentSnapshot): boolean {
  return row.figures_source === undefined && !ownedElsewhere(row);
}
