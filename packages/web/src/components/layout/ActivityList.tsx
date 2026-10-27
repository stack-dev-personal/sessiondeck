/**
 * Hand-written windowed list for one session's activity rows (R6.4). No library: fixed row height,
 * so the window is arithmetic. Only the rows in view plus OVERSCAN above and below are in the DOM,
 * however many (up to ACTIVITY_CAP) the log holds.
 *
 * Pinned to the bottom by default: new rows scroll into view. Scrolling up unpins (the view stays
 * on what the reader is looking at, also when the ring buffer drops its oldest rows); scrolling
 * back to the bottom, End, or the "Jump to latest" button pins again.
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

const Row = memo(function Row({ row, index, h }: { row: ActivityRow; index: number; h: number }) {
  const t = new Date(row.ts);
  const clock = Number.isFinite(t.getTime()) ? t.toTimeString().slice(0, 8) : "n/a";
  return (
    <li
      className="absolute inset-x-0 flex items-center gap-s-2 px-s-2 text-xs"
      style={{ top: index * h, height: h }}
      data-row={row.n}
      data-kind={row.kind}
    >
      <span className="num w-[8ch] shrink-0 text-fg-faint">{clock}</span>
      <span aria-hidden="true" className="num w-[1.5ch] shrink-0 text-fg-muted">
        {row.glyph}
      </span>
      <span className="num w-[7ch] shrink-0 text-fg-muted">{KIND_LABEL[row.kind]}</span>
      <span className="min-w-0 flex-1 truncate text-fg">{row.text}</span>
    </li>
  );
});

export function ActivityList({ rows }: { rows: readonly ActivityRow[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(ROW_H_FALLBACK);
  const [viewH, setViewH] = useState(VIEW_H_FALLBACK);
  const [scrollTop, setScrollTop] = useState(0);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const firstN = useRef(rows[0]?.n ?? 0);

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
  const bottomTop = Math.max(0, total - viewH);
  // While pinned the window follows the bottom even before the scroll event catches up.
  const top = pinned ? bottomTop : scrollTop;

  // After every commit: pinned follows the bottom; unpinned keeps the rows in view when the ring
  // buffer dropped its oldest rows (everything shifted up by that many rows).
  const lastN = rows[rows.length - 1]?.n ?? 0;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const dropped = (rows[0]?.n ?? 0) - firstN.current;
    firstN.current = rows[0]?.n ?? 0;
    if (pinnedRef.current) el.scrollTop = bottomTop;
    else if (dropped > 0) {
      el.scrollTop = Math.max(0, el.scrollTop - dropped * rowH);
      setScrollTop(el.scrollTop);
    }
  }, [lastN, rows, bottomTop, rowH]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= rowH * 1.5;
    const was = pinnedRef.current;
    pinnedRef.current = atBottom;
    // Still pinned: the window already follows the bottom, so no state change, no extra render.
    if (atBottom && was) return;
    setPinned(atBottom);
    setScrollTop(el.scrollTop);
  };
  const jump = useCallback(() => {
    const el = box.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTop = Math.max(0, rows.length * rowH - el.clientHeight);
  }, [rows.length, rowH]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "End") {
      e.preventDefault();
      jump();
    } else if (e.key === "Home") {
      e.preventDefault();
      box.current!.scrollTop = 0;
    }
  };

  const { start, end } = windowOf(rows.length, rowH, top, viewH);
  const visible = rows.slice(start, end);
  return (
    <div className="relative h-full" data-testid="activity-list" data-pinned={pinned}>
      <div
        ref={box}
        role="log"
        aria-label="Session activity"
        aria-live="off"
        tabIndex={0}
        className="h-full overflow-y-auto overflow-x-hidden outline-offset-[-2px]"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        data-total={rows.length}
      >
        <ul className="relative m-0 list-none p-0" style={{ height: total }}>
          {visible.map((r, i) => (
            <Row key={r.n} row={r} index={start + i} h={rowH} />
          ))}
        </ul>
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
