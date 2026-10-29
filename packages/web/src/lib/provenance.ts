import type { SessionSnapshot, SnapshotSources, SubagentSnapshot } from "@sessiondeck/contract";
import { formatCost, formatTokens } from "./format";

/** R3.16: the one marker text for transcript-derived figures. */
export const TRANSCRIPT_LABEL = "from transcript";
/** The single glyph used as the visual marker (always paired with TRANSCRIPT_LABEL as text). */
export const TRANSCRIPT_GLYPH = "†";
/** Cost is the API-priced equivalent of the usage, not a bill. */
export const COST_LABEL = "API-equivalent";

/** True when the hub filled this snapshot figure from the transcript. Statusline or absent: false. */
export function fromTranscript(s: SessionSnapshot, key: keyof SnapshotSources): boolean {
  return s.sources?.[key] === "transcript";
}

/** True when a subagent's tokens, model and window came from its transcript. */
export function subagentFromTranscript(a: SubagentSnapshot): boolean {
  return a.figures_source === "transcript";
}

const FIGURE_NAMES: ReadonlyArray<readonly [keyof SnapshotSources, string]> = [
  ["cost", "cost"],
  ["context", "context"],
  ["model", "model"],
  ["git_branch", "branch"],
  ["last_assistant_message", "last message"],
];

/** Whether the snapshot actually holds a value for this figure (a source with null shows n/a, unmarked). */
function hasValue(s: SessionSnapshot, key: keyof SnapshotSources): boolean {
  switch (key) {
    case "cost":
      return s.cost.usd !== null;
    case "context":
      return s.context.used_pct !== null || s.context.input !== null;
    case "model":
      return s.model !== null;
    case "git_branch":
      return s.git.branch !== null;
    case "last_assistant_message":
      return !!s.last_assistant_message?.trim();
    default:
      return false;
  }
}

/** Sentence for the card's keyboard hint, e.g. "Cost and context are from transcript"; null if none. */
export function transcriptHint(s: SessionSnapshot): string | null {
  const names = FIGURE_NAMES.filter(([k]) => fromTranscript(s, k) && hasValue(s, k)).map(([, n]) => n);
  if (names.length === 0) return null;
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${names.length === 1 ? "is" : "are"} ${TRANSCRIPT_LABEL}`;
}

/** Spoken and tooltip text of the cost figure. */
export function costAria(s: SessionSnapshot): string {
  const base = `${COST_LABEL} cost ${formatCost(s.cost.usd)}`;
  return fromTranscript(s, "cost") && s.cost.usd !== null ? `${base}, ${TRANSCRIPT_LABEL}` : base;
}

/** "94k tok" when the snapshot has context tokens; null otherwise. Never a percent. */
export function contextTokensText(s: SessionSnapshot): string | null {
  return s.context.input === null ? null : `${formatTokens(s.context.input)} tok`;
}
