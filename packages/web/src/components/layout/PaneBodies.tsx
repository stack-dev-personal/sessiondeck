import { useMemo, useRef, useState, useLayoutEffect } from "react";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { useNow } from "../../hooks/useNow";
import { displayNameOf, projectOf, sortForAttention } from "../../lib/attention";
import { STATE_VOCAB } from "../../lib/state-vocab";
import { useBoard } from "../../store/board";
import { useUi } from "../../store/ui";
import { CompactCard, SessionCard } from "../SessionCard";

/** Height of one strip card plus its gap, in px (--strip-h plus the 4 px gap), for the strip/list switch. */
const STRIP_H = 36;

function useSortedSessions(): SessionSnapshot[] {
  const sessions = useBoard((s) => s.sessions);
  return useMemo(() => sortForAttention(Object.values(sessions)), [sessions]);
}

function useHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

const Empty = ({ children }: { children: string }) => (
  <p className="m-0 p-s-3 text-sm text-fg-muted">{children}</p>
);

/**
 * Board pane: compact cards in attention order. A pane only one strip tall scrolls horizontally
 * (design system 5.4); a taller pane lists them in a column.
 */
export function BoardPaneBody() {
  const list = useSortedSessions();
  const flags = useBoard((s) => s.exceeds200k);
  const openSession = useUi((s) => s.openSession);
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const h = useHeight(ref);
  const strip = h < STRIP_H * 2;
  return (
    <div
      ref={ref}
      className={`h-full min-h-0 ${strip ? "overflow-x-auto overflow-y-hidden" : "overflow-auto"}`}
      data-form={strip ? "strip" : "list"}
    >
      {list.length === 0 ? (
        <Empty>No sessions yet.</Empty>
      ) : (
        <ul
          className={`m-0 flex list-none gap-s-1 p-0 ${strip ? "w-max flex-row" : "min-w-[37rem] flex-col"}`}
          aria-label="Board strip"
        >
          {list.map((s) => (
            <li key={s.session_id} className={strip ? "w-[37rem] shrink-0" : ""}>
              <CompactCard
                s={s}
                now={now}
                exceeds200k={flags[s.session_id] ?? null}
                onOpen={openSession}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * SEAM (R6.4): the live content view of one session. Phase 6 later replaces this body with the
 * virtualized live message list; the pane chrome, assignment and compact handling stay as they are.
 * Until then it shows the session's card, or the unassigned state.
 */
export function SessionPaneBody({ sessionId }: { sessionId: string | undefined }) {
  const s = useBoard((st) => (sessionId === undefined ? undefined : st.sessions[sessionId]));
  const flag = useBoard((st) =>
    sessionId === undefined ? null : (st.exceeds200k[sessionId] ?? null),
  );
  const openSession = useUi((st) => st.openSession);
  const now = useNow();
  if (sessionId === undefined)
    return (
      <div data-unassigned="true">
        <Empty>Unassigned. Assign a session to see its content here.</Empty>
      </div>
    );
  if (!s) return <Empty>{`Session ${sessionId} is not on the board.`}</Empty>;
  return (
    <div className="h-full overflow-auto">
      <div className="min-w-[28rem] p-s-2">
        <SessionCard s={s} now={now} exceeds200k={flag} onOpen={openSession} />
      </div>
    </div>
  );
}

/** Project pane: that project's sessions, stacked in attention order. */
export function ProjectPaneBody({ projectDir }: { projectDir: string | undefined }) {
  const list = useSortedSessions();
  const flags = useBoard((s) => s.exceeds200k);
  const openSession = useUi((s) => s.openSession);
  const now = useNow();
  if (projectDir === undefined)
    return (
      <div data-unassigned="true">
        <Empty>Unassigned. No project chosen for this pane.</Empty>
      </div>
    );
  const mine = list.filter((s) => projectOf(s) === projectDir);
  if (mine.length === 0) return <Empty>{`No sessions in ${projectDir}.`}</Empty>;
  return (
    <div className="h-full overflow-auto">
      <ul
        className="m-0 flex min-w-[28rem] list-none flex-col gap-s-2 p-s-2"
        aria-label={`${projectDir} sessions`}
      >
        {mine.map((s) => (
          <li key={s.session_id} className="min-w-0">
            <SessionCard
              s={s}
              now={now}
              exceeds200k={flags[s.session_id] ?? null}
              onOpen={openSession}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Metrics pane: counts by state, glyph and label with the number (never color alone). */
export function MetricsPaneBody() {
  const sessions = useBoard((s) => s.sessions);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of Object.values(sessions)) c[s.state] = (c[s.state] ?? 0) + 1;
    return c;
  }, [sessions]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr_auto] items-center gap-x-s-3 gap-y-s-1 p-s-3 text-sm">
      {Object.entries(STATE_VOCAB).map(([state, v]) => (
        <div key={state} className="contents" data-metric={state}>
          <dt className={`num ${v.textClass}`} aria-hidden="true">
            {v.glyph}
          </dt>
          <dt className="text-fg">{v.label}</dt>
          <dd className="num m-0 text-right text-fg">{counts[state] ?? 0}</dd>
        </div>
      ))}
      <dt />
      <dt className="text-fg-muted">Total</dt>
      <dd className="num m-0 text-right text-fg">{total}</dd>
    </dl>
  );
}

/** What a collapsed pane shows: one line, never the heavy body. */
export function CompactPaneBody({
  type,
  sessionId,
  projectDir,
}: {
  type: "board" | "session" | "project" | "metrics";
  sessionId: string | undefined;
  projectDir: string | undefined;
}) {
  const sessions = useBoard((s) => s.sessions);
  const text = useMemo(() => {
    const all = Object.values(sessions);
    if (type === "session") {
      const s = sessionId === undefined ? undefined : sessions[sessionId];
      return sessionId === undefined
        ? "Unassigned"
        : s
          ? `${STATE_VOCAB[s.state].glyph} ${displayNameOf(s)}: ${STATE_VOCAB[s.state].label}`
          : `${sessionId} not on the board`;
    }
    if (type === "project") {
      if (projectDir === undefined) return "Unassigned";
      return `${projectDir}: ${all.filter((s) => projectOf(s) === projectDir).length} sessions`;
    }
    return `${all.length} sessions`;
  }, [sessions, type, sessionId, projectDir]);
  return <p className="num m-0 truncate px-s-2 py-s-1 text-sm text-fg-muted">{text}</p>;
}
