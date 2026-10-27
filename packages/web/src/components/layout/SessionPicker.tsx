import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { displayNameOf, projectOf, sortForAttention } from "../../lib/attention";
import { STATE_VOCAB } from "../../lib/state-vocab";
import { panesOf } from "../../layout/spec";
import { useBoard } from "../../store/board";
import { useLayout } from "../../store/layout";
import { useUi } from "../../store/ui";

/** Rows rendered at once; a filter narrows the rest (the list is never longer than this in the DOM). */
export const PICKER_MAX_ROWS = 100;

/**
 * Keyboard assignment (R6.6): Enter or g on a focused session pane opens this. Type to filter, Up
 * and Down move, Enter assigns the highlighted session to the pane, Esc cancels. Sessions are listed
 * in attention order; one already shown in another pane says where, and assigning it moves or swaps.
 */
export function SessionPicker({ paneId, onClose }: { paneId: string; onClose: () => void }) {
  const sessions = useBoard((s) => s.sessions);
  const spec = useLayout((s) => s.spec);
  const assign = useLayout((s) => s.assign);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const titleId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const sessionPanes = useMemo(() => panesOf(spec).filter((p) => p.type === "session"), [spec]);
  const placed = useMemo(() => {
    const m = new Map<string, number>();
    sessionPanes.forEach((p, i) => p.sessionId !== undefined && m.set(p.sessionId, i + 1));
    return m;
  }, [sessionPanes]);
  const here = sessionPanes.findIndex((p) => p.id === paneId) + 1;
  const sorted = useMemo(() => sortForAttention(Object.values(sessions)), [sessions]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q === ""
        ? sorted
        : sorted.filter((s) =>
            [displayNameOf(s), projectOf(s), s.session_id, s.host, STATE_VOCAB[s.state].label].some(
              (t) => t.toLowerCase().includes(q),
            ),
          ),
    [sorted, q],
  );
  const shown = matches.slice(0, PICKER_MAX_ROWS);
  const cur = Math.min(active, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    useUi.getState().setModalOpen(true);
    return () => {
      useUi.getState().setModalOpen(false);
      prev?.focus?.();
    };
  }, []);
  useEffect(() => {
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);
  useEffect(() => {
    document.getElementById(`${listId}-${cur}`)?.scrollIntoView?.({ block: "nearest" });
  }, [cur, listId]);

  const choose = (i: number) => {
    const s = shown[i];
    if (!s) return;
    assign(paneId, s.session_id);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive(Math.min(shown.length - 1, cur + 1));
    else if (e.key === "ArrowUp") setActive(Math.max(0, cur - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(Math.max(0, shown.length - 1));
    else if (e.key === "Enter") choose(cur);
    else if (e.key === "Tab") {
      e.preventDefault(); // the dialog is one control: focus stays in the filter box
    } else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <>
      <div aria-hidden="true" className="sd-scrim fixed inset-0 z-30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="session-picker"
        className="fixed left-1/2 top-s-8 z-40 flex max-h-[80vh] w-[40rem] max-w-[95vw] -translate-x-1/2 flex-col gap-s-2 rounded border border-border-strong bg-surface-1 p-s-4 text-sm text-fg"
      >
        <h2 id={titleId} className="m-0 text-lg font-normal">
          {`Assign a session to pane ${here}`}
        </h2>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown.length ? `${listId}-${cur}` : undefined}
          aria-label="Filter sessions"
          placeholder="Type to filter; Up and Down move; Enter assigns; Esc cancels"
          className="rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <ul
          id={listId}
          role="listbox"
          aria-label="Sessions, most urgent first"
          className="m-0 h-[20rem] list-none overflow-auto p-0"
        >
          {shown.map((s, i) => {
            const v = STATE_VOCAB[s.state];
            const at = placed.get(s.session_id);
            return (
              <li
                key={s.session_id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === cur}
                data-session-id={s.session_id}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
                className={`num flex h-[var(--strip-h)] cursor-pointer items-center gap-s-2 overflow-hidden whitespace-nowrap rounded px-s-2 ${i === cur ? "bg-surface-3 outline outline-1 -outline-offset-1 outline-accent" : ""}`}
              >
                <span className={`w-36 shrink-0 truncate ${v.textClass}`}>
                  <span aria-hidden="true">{v.glyph}</span> {v.label}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-fg-muted">{projectOf(s)}</span> · {displayNameOf(s)}
                </span>
                <span className="w-24 shrink-0 text-right text-xs text-fg-muted">
                  {at === undefined ? "" : at === here ? "this pane" : `in pane ${at}`}
                </span>
              </li>
            );
          })}
          {shown.length === 0 ? (
            <li className="p-s-2 text-fg-muted">
              {sorted.length === 0 ? "No sessions yet." : "No session matches."}
            </li>
          ) : null}
        </ul>
        <p className="num m-0 h-[1.5em] text-xs text-fg-muted" data-testid="picker-count">
          {matches.length > shown.length
            ? `Showing ${shown.length} of ${matches.length}; keep typing to narrow.`
            : `${matches.length} ${matches.length === 1 ? "session" : "sessions"}`}
        </p>
      </div>
    </>
  );
}
