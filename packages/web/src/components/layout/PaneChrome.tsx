import type { ReactNode } from "react";
import type { Pane } from "../../layout/spec";
import { useLayout } from "../../store/layout";

const TYPE_LABEL: Record<Pane["type"], string> = {
  board: "Board",
  session: "Session",
  project: "Project",
  metrics: "Metrics",
};

/**
 * Pane frame (design system 5.4): 28 px header with the pane type and a compact control. The
 * header never changes height; the body takes the rest and scrolls on its own.
 */
export function PaneChrome({ pane, children }: { pane: Pane; children: ReactNode }) {
  const setCompact = useLayout((s) => s.setPaneCompact);
  const compact = pane.compact === true;
  const detail =
    pane.type === "project"
      ? pane.projectDir
      : pane.type === "session"
        ? pane.sessionId
        : undefined;
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1"
      aria-label={`${TYPE_LABEL[pane.type]} pane`}
      data-testid="pane"
      data-pane-id={pane.id}
      data-pane-type={pane.type}
      data-compact={compact ? "true" : undefined}
    >
      <header className="flex h-[var(--pane-head-h)] shrink-0 items-center gap-s-2 border-b border-border bg-surface-2 px-s-2 text-xs">
        <strong className="font-semibold text-fg">{TYPE_LABEL[pane.type]}</strong>
        <span className="num min-w-0 flex-1 truncate text-fg-muted">
          {detail ?? (pane.type === "session" || pane.type === "project" ? "unassigned" : "")}
        </span>
        <button
          type="button"
          className="num rounded border border-border-control px-s-2 text-fg hover:bg-surface-3"
          aria-pressed={compact}
          aria-label={
            compact
              ? `Expand ${TYPE_LABEL[pane.type]} pane`
              : `Compact ${TYPE_LABEL[pane.type]} pane`
          }
          onClick={() => setCompact(pane.id, !compact)}
        >
          <span aria-hidden="true">{compact ? "▸" : "▾"}</span> {compact ? "Expand" : "Compact"}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden" data-slot="pane-body">
        {children}
      </div>
    </section>
  );
}
