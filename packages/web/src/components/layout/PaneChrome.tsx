import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { panesOf, type Pane } from "../../layout/spec";
import { displayNameOf } from "../../lib/attention";
import { LAYOUT_KEYS, keyName } from "../../lib/keys";
import { useBoard } from "../../store/board";
import { useLayout } from "../../store/layout";
import { hasSessionDrag, isKnownSession, sessionDragProps, sessionFromDrop } from "./dnd";
import { useProjectLabel } from "./PaneBodies";
import { SessionPicker } from "./SessionPicker";

const TYPE_LABEL: Record<Pane["type"], string> = {
  board: "Board",
  session: "Session",
  project: "Project",
  metrics: "Metrics",
};

/**
 * Pane frame (design system 5.4): 28 px header with the pane type and a compact control. The
 * header never changes height; the body takes the rest and scrolls on its own.
 *
 * A session pane (R6.6) is also a tab stop with a focus ring: Enter or g opens the session picker,
 * Delete or Backspace unassigns. It is a drop target for session cards and, when it holds a
 * session, its header is a drag source (drop on another pane to move or swap).
 */
export function PaneChrome({ pane, children }: { pane: Pane; children: ReactNode }) {
  const setCompact = useLayout((s) => s.setPaneCompact);
  const assign = useLayout((s) => s.assign);
  const unassign = useLayout((s) => s.unassign);
  const compact = pane.compact === true;
  const projectLabel = useProjectLabel(pane.type === "project" ? pane.projectDir : undefined);
  const [picking, setPicking] = useState(false);
  const [over, setOver] = useState(false);
  const isSession = pane.type === "session";
  // Which session pane this is (1-based, reading order) and what it holds, for its accessible name.
  const ordinal = useLayout((s) => {
    const ids = panesOf(s.spec).filter((p) => p.type === "session");
    return ids.findIndex((p) => p.id === pane.id) + 1;
  });
  const held = useBoard((s) =>
    pane.sessionId !== undefined ? s.sessions[pane.sessionId] : undefined,
  );
  const heldName = held ? displayNameOf(held) : (pane.sessionId ?? "unassigned");
  const detail =
    pane.type === "project" ? projectLabel : pane.type === "session" ? pane.sessionId : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!isSession || e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (LAYOUT_KEYS.pick.includes(keyName(e))) {
      if (e.repeat) return;
      e.preventDefault();
      setPicking(true);
    } else if (LAYOUT_KEYS.unassign.includes(e.key)) {
      e.preventDefault();
      unassign(pane.id);
    }
  };
  const drop = isSession
    ? {
        onDragEnter: (e: DragEvent) => {
          if (hasSessionDrag(e.dataTransfer)) setOver(true);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasSessionDrag(e.dataTransfer)) return;
          e.preventDefault(); // allows the drop
          e.dataTransfer.dropEffect = "move";
          setOver(true);
        },
        onDragLeave: (e: DragEvent<HTMLElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        },
        onDrop: (e: DragEvent) => {
          const id = sessionFromDrop(e.dataTransfer);
          setOver(false);
          if (id === null) return;
          e.preventDefault();
          if (!isKnownSession(id)) return;
          assign(pane.id, id);
        },
      }
    : {};
  return (
    <section
      className={`flex h-full min-h-0 min-w-0 flex-col bg-surface-1 outline-offset-[-2px] ${over ? "outline outline-2 outline-accent" : ""}`}
      aria-label={
        isSession ? `Session pane ${ordinal}: ${heldName}` : `${TYPE_LABEL[pane.type]} pane`
      }
      data-testid="pane"
      data-pane-id={pane.id}
      data-pane-type={pane.type}
      data-compact={compact ? "true" : undefined}
      data-session-id={isSession ? pane.sessionId : undefined}
      data-drop={over ? "true" : undefined}
      tabIndex={isSession ? 0 : undefined}
      aria-keyshortcuts={isSession ? "Enter g Delete" : undefined}
      onKeyDown={onKeyDown}
      {...drop}
    >
      <header
        className="flex h-[var(--pane-head-h)] shrink-0 items-center gap-s-2 border-b border-border bg-surface-2 px-s-2 text-xs"
        {...(isSession && pane.sessionId !== undefined ? sessionDragProps(pane.sessionId) : {})}
        data-testid="pane-header"
      >
        <strong className="font-semibold text-fg">{TYPE_LABEL[pane.type]}</strong>
        <span className="num min-w-0 flex-1 truncate text-fg-muted">
          {over
            ? "Drop to assign"
            : (detail ?? (pane.type === "session" || pane.type === "project" ? "unassigned" : ""))}
        </span>
        {isSession ? (
          <button
            type="button"
            className="num shrink-0 rounded border border-border-control px-s-2 text-fg hover:bg-surface-3"
            aria-label="Assign a session to this pane"
            aria-keyshortcuts="Enter g"
            onClick={() => setPicking(true)}
          >
            Assign
          </button>
        ) : null}
        <button
          type="button"
          className="num shrink-0 rounded border border-border-control px-s-2 text-fg hover:bg-surface-3"
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
      {picking ? <SessionPicker paneId={pane.id} onClose={() => setPicking(false)} /> : null}
    </section>
  );
}
