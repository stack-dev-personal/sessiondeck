import { useLayoutEffect, useMemo, useRef } from "react";
import { BoardToolbar } from "../components/BoardToolbar";
import { CompactCard, SessionCard } from "../components/SessionCard";
import { useNow } from "../hooks/useNow";
import { applyFilters, isAttentionState } from "../lib/attention";
import { useDisplayActivity } from "../hooks/useDisplayActivity";
import { useShortcuts } from "../lib/keys";
import { reorderChildren } from "../lib/reorder";
import { useBoard } from "../store/board";
import { useFilters } from "../store/filters";
import { useUi } from "../store/ui";

/**
 * Display order (R3.10: waiting first, then working, then idle, stable inside a group; see
 * display-activity) after the host and project filters. The sort runs in the same render as the state change, so a card moves with no
 * animation delay. Full: responsive grid of 6-row cards.
 * Compact: a dense single-column list of 36 px rows (the horizontally scrolling strip of design
 * system 5.4 is a layout pane form, built with layouts in Phase 6).
 */
export function Board() {
  const sessions = useBoard((s) => s.sessions);
  const flags = useBoard((s) => s.exceeds200k);
  const compact = useUi((s) => s.compact);
  const now = useNow();
  const openSession = useUi((s) => s.openSession);
  const listRef = useRef<HTMLUListElement>(null);
  const keys = useMemo(() => {
    /** j/k clamp at the first and last card. With no card focused, j goes first and k goes last. */
    const move = (dir: 1 | -1) => () => {
      if (useUi.getState().selectedSessionId !== null || !listRef.current) return;
      const cards = Array.from(
        listRef.current.querySelectorAll<HTMLElement>('[data-testid="session-card"]'),
      );
      if (cards.length === 0) return;
      const cur = cards.findIndex((c) => c === document.activeElement);
      const next = cur === -1 ? (dir === 1 ? 0 : cards.length - 1) : cur + dir;
      cards[Math.min(cards.length - 1, Math.max(0, next))]?.focus();
    };
    return { j: move(1), k: move(-1) };
  }, []);
  useShortcuts(keys);
  const host = useFilters((s) => s.host);
  const project = useFilters((s) => s.project);
  const all = useMemo(() => Object.values(sessions), [sessions]);
  // R3.10: hysteresis and a stable order come from the display layer; filters apply after it so
  // changing a filter never restarts a grace period.
  const graceSec = useUi((s) => s.settings.idleGraceSec);
  const rows = useDisplayActivity(all, graceSec);
  const list = useMemo(() => {
    const keep = new Set(applyFilters(all, { host, project }).map((s) => s.session_id));
    return rows.filter((r) => keep.has(r.session.session_id));
  }, [rows, all, host, project]);
  const groupOf = new Map(list.map((r) => [r.session.session_id, r.group]));
  /** Waiting sessions the filters leave out; the toolbar says so, because nothing else would. */
  const hiddenAttention = useMemo(() => {
    const shown = new Set(list.map((r) => r.session.session_id));
    return all.filter((s) => isAttentionState(s.state) && !shown.has(s.session_id)).length;
  }, [all, list]);
  // R3.6: React keeps a stable child order (first seen first) so it never moves a card itself; the
  // layout effect below puts the DOM into sort order with the fewest moves. React's own keyed
  // reconciliation moved every card a moved one passed, and a moved card pays style, layout and
  // paint again.
  const stable = useRef<string[]>([]);
  const present = new Set(list.map((r) => r.session.session_id));
  const kept = stable.current.filter((id) => present.has(id));
  const known = new Set(kept);
  for (const r of list) if (!known.has(r.session.session_id)) kept.push(r.session.session_id);
  stable.current = kept;
  const byId = new Map(list.map((r) => [r.session.session_id, r.session]));
  const sortedIds = list.map((r) => r.session.session_id);
  useLayoutEffect(() => {
    if (listRef.current) reorderChildren(listRef.current, sortedIds);
  });
  // A reorder moves DOM nodes, which can drop focus to <body>; put it back on the same card.
  const focusedId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusedId.current;
    if (id === null || document.activeElement !== document.body) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    const track = (e: FocusEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      focusedId.current =
        t !== null && listRef.current?.contains(t)
          ? (t.getAttribute("data-session-id") ?? null)
          : null;
    };
    const clear = () => {
      focusedId.current = null;
    };
    document.addEventListener("focusin", track);
    document.addEventListener("pointerdown", clear);
    return () => {
      document.removeEventListener("focusin", track);
      document.removeEventListener("pointerdown", clear);
    };
  }, []);
  const empty =
    list.length === 0 ? (
      <p className="p-s-4 text-fg-muted">
        {all.length === 0 ? "No sessions yet." : "No sessions match the filters."}
      </p>
    ) : null;
  return (
    <>
      <h1 className="sr-only">Board</h1>
      <BoardToolbar shown={list.length} total={all.length} hiddenAttention={hiddenAttention} />
      {empty}
      {list.length === 0 ? null : (
        <ul
          ref={listRef}
          className={
            compact
              ? "m-0 flex list-none flex-col gap-s-1 p-s-4"
              : "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(28rem,100%),1fr))] gap-s-3 p-s-4"
          }
          aria-label="Sessions"
          data-density={compact ? "compact" : "full"}
        >
          {kept
            .map((id) => byId.get(id)!)
            .map((s) => (
              <li
                key={s.session_id}
                data-row={s.session_id}
                data-group={groupOf.get(s.session_id)}
                data-testid="board-row"
                className="min-w-0"
              >
                {compact ? (
                  <CompactCard
                    s={s}
                    now={now}
                    exceeds200k={flags[s.session_id] ?? null}
                    onOpen={openSession}
                  />
                ) : (
                  <SessionCard
                    s={s}
                    now={now}
                    exceeds200k={flags[s.session_id] ?? null}
                    onOpen={openSession}
                  />
                )}
              </li>
            ))}
        </ul>
      )}
    </>
  );
}
