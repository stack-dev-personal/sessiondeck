/**
 * Hand-written windowed list for one session's activity rows (R6.4). No library: fixed row height,
 * so the window is arithmetic. Only the rows in view plus OVERSCAN above and below are in the DOM,
 * however many (up to ACTIVITY_CAP) the log holds.
 *
 * The scroller is a column-reverse flex box: scrollTop 0 is the bottom and scrolling up goes
 * negative. So "pinned to the bottom" is the browser's own resting state: new rows need no script
 * scroll write, no scroll event and no forced layout (those cost about 20 percent of a frame for
 * six live lists in the first version). Scrolling up unpins; the view then stays on the rows the
 * reader is looking at (the scroll distance grows by the rows appended). Scrolling back to the
 * bottom, End, or the "Jump to latest" button pins again.
 */
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import { KIND_LABEL, type ActivityRow } from "../../store/activity";

export const OVERSCAN = 6;
/** Fallbacks for jsdom, where nothing has a size. */
const ROW_H_FALLBACK = 24;
const VIEW_H_FALLBACK = 240;

/** Rows [start, end) that must be mounted for a viewport at `top` px. Pure. */
export function windowOf(
  count: number,
  rowH: number,
  top: number,
  viewH: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
  const first = Math.floor(Math.max(0, top) / rowH);
  const last = Math.ceil((Math.max(0, top) + viewH) / rowH);
  const end = Math.min(count, last + overscan);
  return { start: Math.min(end, Math.max(0, first - overscan)), end };
}

/**
 * One row, two text nodes: time and kind label (fixed-width, preformatted), then the text. Few DOM
 * nodes per row keep paint cheap when six live lists repaint on every update. The kind label is the
 * non-color cue; the state glyph, where there is one, is in the text itself.
 */
const Row = memo(function Row({ row, h }: { row: ActivityRow; h: number }) {
  const t = new Date(row.ts);
  const clock = Number.isFinite(t.getTime()) ? t.toTimeString().slice(0, 8) : "n/a";
  return (
    <li
      className="flex items-center gap-s-2 whitespace-pre px-s-2 text-xs [contain:layout_paint_style]"
      style={{ height: h }}
      data-row={row.n}
      data-kind={row.kind}
    >
      <span className="num shrink-0 text-fg-muted">{`${clock}  ${KIND_LABEL[row.kind].padEnd(6)}`}</span>
      <span className="min-w-0 flex-1 truncate text-fg">{row.text}</span>
    </li>
  );
});

export function ActivityList({ rows }: { rows: readonly ActivityRow[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(ROW_H_FALLBACK);
  const [viewH, setViewH] = useState(VIEW_H_FALLBACK);
  /** Pixels between the bottom of the list and the bottom of the view; 0 means pinned. */
  const [dist, setDist] = useState(0);
  const pinnedRef = useRef(true);
  const lastN = useRef(rows[rows.length - 1]?.n ?? 0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = parseFloat(getComputedStyle(el).getPropertyValue("--activity-row-h"));
    if (Number.isFinite(h) && h > 0) setRowH(h);
    const read = () => {
      if (el.clientHeight > 0) setViewH(el.clientHeight);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = rows.length * rowH;
  const pinned = dist <= rowH * 1.5;
  const top = Math.max(0, total - viewH - (pinned ? 0 : dist));

  // Unpinned: every appended row grows the list below the reader, so move the view up by as much
  // (also when the ring buffer drops its oldest rows at the same time).
  const newest = rows[rows.length - 1]?.n ?? 0;
  useLayoutEffect(() => {
    const appended = newest - lastN.current;
    lastN.current = newest;
    const el = box.current;
    if (!el || pinnedRef.current || appended <= 0) return;
    const next = Math.min(Math.max(0, total - viewH), -el.scrollTop + appended * rowH);
    el.scrollTop = -next;
    setDist(next);
  }, [newest, total, viewH, rowH]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const d = Math.max(0, -e.currentTarget.scrollTop);
    const nowPinned = d <= rowH * 1.5;
    pinnedRef.current = nowPinned;
    // Still pinned: the window already follows the bottom, so no state change, no extra render.
    if (nowPinned && pinned) return;
    setDist(nowPinned ? 0 : d);
  };
  const jump = useCallback(() => {
    const el = box.current;
    if (!el) return;
    pinnedRef.current = true;
    setDist(0);
    el.scrollTop = 0;
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "End") {
      e.preventDefault();
      jump();
    } else if (e.key === "Home") {
      e.preventDefault();
      const el = box.current!;
      el.scrollTop = -Math.max(0, el.scrollHeight - el.clientHeight);
    }
  };

  const { start, end } = windowOf(rows.length, rowH, top, viewH);
  const visible = rows.slice(start, end);
  return (
    <div
      className="relative h-full [contain:layout_paint_style] [will-change:transform]"
      data-testid="activity-list"
      data-pinned={pinned}
    >
      <div
        ref={box}
        role="log"
        aria-label="Session activity"
        aria-live="off"
        tabIndex={0}
        className="flex h-full flex-col-reverse overflow-y-auto overflow-x-hidden outline-offset-[-2px]"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        data-total={rows.length}
      >
        <div className="relative mb-auto shrink-0" style={{ height: total }}>
          <ul
            className="absolute inset-x-0 m-0 list-none p-0"
            style={{ top: start * rowH }}
            data-window={`${start}-${end}`}
          >
            {visible.map((r) => (
              <Row key={r.n} row={r} h={rowH} />
            ))}
          </ul>
        </div>
      </div>
      {pinned ? null : (
        <button
          type="button"
          className="num absolute bottom-s-2 right-s-3 rounded border border-border-strong bg-surface-2 px-s-2 py-s-1 text-xs text-fg hover:bg-surface-3"
          onClick={jump}
          aria-keyshortcuts="End"
        >
          <span aria-hidden="true">▾</span> Jump to latest
        </button>
      )}
    </div>
  );
}
