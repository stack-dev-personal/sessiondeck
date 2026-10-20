import { useMemo } from "react";
import { CompactCard, SessionCard } from "../components/SessionCard";
import { useNow } from "../hooks/useNow";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

/**
 * Store order (no attention sorting yet, session S6). Full: responsive grid of 6-row cards.
 * Compact: a dense single-column list of 36 px rows (the horizontally scrolling strip of design
 * system 5.4 is a layout pane form, built with layouts in Phase 6).
 */
export function Board() {
  const sessions = useBoard((s) => s.sessions);
  const compact = useUi((s) => s.compact);
  const now = useNow();
  const list = useMemo(() => Object.values(sessions), [sessions]);
  if (list.length === 0) {
    return <p className="p-s-4 text-fg-muted">No sessions yet.</p>;
  }
  return (
    <ul
      className={
        compact
          ? "m-0 flex list-none flex-col gap-s-1 p-s-4"
          : "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(28rem,1fr))] gap-s-3 p-s-4"
      }
      aria-label="Sessions"
      data-density={compact ? "compact" : "full"}
    >
      {list.map((s) => (
        <li key={s.session_id} className="min-w-0">
          {compact ? <CompactCard s={s} now={now} /> : <SessionCard s={s} now={now} />}
        </li>
      ))}
    </ul>
  );
}
