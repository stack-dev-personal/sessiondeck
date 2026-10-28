import type { SessionSnapshot } from "@sessiondeck/contract";
import { savePhase } from "../atlas/actions";
import { atlasOf } from "../atlas/types";
import { displayNameOf } from "../lib/attention";
import { InlineEdit } from "./InlineEdit";

export const PHASE_MAX = 60;

/** Where the shown phase came from, in words (never color alone). */
export function phaseSourceWord(source: "manual" | "inferred" | null): string {
  return source === "manual" ? "manual" : source === "inferred" ? "inferred" : "none";
}

/**
 * The session's phase as an inline editor. Shows the effective phase and whether it is manual or
 * inferred. Enter saves (PATCH /sessions/:id/phase), Escape cancels, an empty value clears the
 * manual label so the inferred one shows again.
 */
export function PhaseChip({
  session,
  onSaved,
}: {
  session: SessionSnapshot;
  onSaved?: () => void;
}) {
  const { phase, phase_source } = atlasOf(session);
  const source = phase === null ? null : phase_source;
  const word = phaseSourceWord(source);
  const name = displayNameOf(session);
  return (
    <InlineEdit
      testId="phase-chip"
      className="w-44 shrink-0"
      value={source === "manual" ? (phase ?? "") : ""}
      label={`Phase for ${name}: ${phase === null ? "none" : `${phase} (${word})`}`}
      hint="Enter saves, Escape cancels, empty restores the inferred phase"
      maxLength={PHASE_MAX}
      onSave={async (text) => {
        await savePhase(session.session_id, text === "" ? null : text);
        onSaved?.();
      }}
    >
      <span data-slot="phase" className={`num truncate ${phase ? "" : "text-fg-muted"}`}>
        {phase ?? "none"}
      </span>
      {phase === null ? null : (
        <span data-slot="phase-source" className="shrink-0 text-xs text-fg-muted">
          {word}
        </span>
      )}
    </InlineEdit>
  );
}
