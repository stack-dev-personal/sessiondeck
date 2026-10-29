import { TRANSCRIPT_GLYPH, TRANSCRIPT_LABEL } from "../lib/provenance";

/**
 * The one marker for transcript-derived figures (R3.16): a quiet dagger with a tooltip. The glyph is
 * decoration; the text "from transcript" is always in the accessibility tree.
 */
export function SourceMark({ className = "" }: { className?: string }) {
  return (
    <span
      data-source="transcript"
      title={TRANSCRIPT_LABEL}
      className={`num text-fg-muted ${className}`}
    >
      <span aria-hidden="true">{TRANSCRIPT_GLYPH}</span>
      <span className="sr-only">{TRANSCRIPT_LABEL}</span>
    </span>
  );
}
