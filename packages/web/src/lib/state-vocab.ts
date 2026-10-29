import type { SessionState } from "@sessiondeck/contract";

/** Design system section 3: glyph, label, color token for every state. Never color alone. */
export interface StateVocab {
  glyph: string;
  label: string;
  /** Tailwind text color class (maps to --state-*). */
  textClass: string;
  attention: boolean;
}

export const STATE_VOCAB: Record<SessionState, StateVocab> = {
  starting: { glyph: "◌", label: "Starting", textClass: "text-state-starting", attention: false },
  working: { glyph: "●", label: "Working", textClass: "text-state-working", attention: false },
  waiting_permission: {
    glyph: "▲",
    label: "Needs permission",
    textClass: "text-state-waiting",
    attention: true,
  },
  waiting_input: {
    glyph: "▲",
    label: "Needs input",
    textClass: "text-state-waiting",
    attention: true,
  },
  idle: { glyph: "○", label: "Idle", textClass: "text-state-idle", attention: false },
  error: { glyph: "✖", label: "Error", textClass: "text-state-error", attention: false },
  ended: { glyph: "■", label: "Ended", textClass: "text-state-ended", attention: false },
  exited: { glyph: "◆", label: "Exited", textClass: "text-state-exited", attention: false },
};

/** Marks a session whose vault capture is attached (R5.3). Same glyph, label, color rule as the states. */
export const ARCHIVED_VOCAB: StateVocab = {
  glyph: "▤",
  label: "Archived",
  textClass: "text-state-ended",
  attention: false,
};
