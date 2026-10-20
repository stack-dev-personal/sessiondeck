import { useMemo, useRef } from "react";
import { CompactCard, SessionCard } from "../components/SessionCard";
import { useNow } from "../hooks/useNow";
import { useShortcuts } from "../lib/keys";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

/**
 * Store order (no attention sorting yet, session S6). Full: responsive grid of 6-row cards.
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
  const list = useMemo(() => Object.values(sessions), [sessions]);
  if (list.length === 0) {
    return (
      <>
        <h1 className="sr-only">Board</h1>
        <p className="p-s-4 text-fg-muted">No sessions yet.</p>
      </>
    );
  }
  return (
    <>
      <h1 className="sr-only">Board</h1>
      <ul
        ref={listRef}
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
    </>
  );
}
