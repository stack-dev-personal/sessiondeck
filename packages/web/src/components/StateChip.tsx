import type { SessionState } from "@sessiondeck/contract";
import { STATE_VOCAB } from "../lib/state-vocab";

/** Glyph + label + color, never color alone (design system section 3). */
export function StateChip({ state, detail }: { state: SessionState; detail?: string | null }) {
  const v = STATE_VOCAB[state];
  return (
    <span className={`inline-flex min-w-0 items-center gap-s-2 ${v.textClass}`} data-state={state}>
      <span aria-hidden="true" className={`num shrink-0 ${state === "working" ? "sd-pulse" : ""}`}>
        {v.glyph}
      </span>
      <span className="shrink-0">{v.label}</span>
      {detail ? (
        <span data-part="detail" title={detail} className="num min-w-[10ch] truncate text-fg-muted">
          · {detail}
        </span>
      ) : null}
    </span>
  );
}
