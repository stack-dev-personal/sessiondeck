import type { SessionState } from "@sessiondeck/contract";
import { STATE_VOCAB } from "../lib/state-vocab";

/** Glyph + label + color, never color alone (design system section 3). */
export function StateChip({ state, detail }: { state: SessionState; detail?: string | null }) {
  const v = STATE_VOCAB[state];
  return (
    <span className={`inline-flex items-center gap-s-2 ${v.textClass}`} data-state={state}>
      <span aria-hidden="true" className={`num ${state === "working" ? "sd-pulse" : ""}`}>
        {v.glyph}
      </span>
      <span>{v.label}</span>
      {detail ? <span className="num text-fg-muted">· {detail}</span> : null}
    </span>
  );
}
