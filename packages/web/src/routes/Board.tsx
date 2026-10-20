import { useMemo } from "react";
import { StateChip } from "../components/StateChip";
import { useBoard } from "../store/board";

/** Plain list for now; U2 replaces each row with the session card. */
export function Board() {
  const sessions = useBoard((s) => s.sessions);
  const list = useMemo(
    () => Object.values(sessions).sort((a, b) => b.last_event_at - a.last_event_at),
    [sessions],
  );
  if (list.length === 0) {
    return <p className="p-s-4 text-fg-muted">No sessions yet.</p>;
  }
  return (
    <ul className="m-0 list-none p-s-4" aria-label="Sessions">
      {list.map((s) => (
        <li
          key={s.session_id}
          className="flex items-center gap-s-4 border-b border-border py-s-2"
          data-testid="session-row"
        >
          <span className="w-64 shrink-0">
            <StateChip state={s.state} detail={s.state_detail} />
          </span>
          <span className="truncate">
            {s.session_name ?? s.cwd.split("/").pop() ?? s.session_id}
          </span>
          <span className="num ml-auto text-sm text-fg-faint">{s.host}</span>
        </li>
      ))}
    </ul>
  );
}
