import { useEffect, useRef, useState, type ReactNode } from "react";

export const VIRTUAL_THRESHOLD = 100;

/**
 * List of fixed-height rows. Up to VIRTUAL_THRESHOLD items every row is in the DOM; above it only
 * the rows in view (plus overscan) are, inside a scroll box of fixed height.
 */
export function FixedList<T>({
  items,
  rowHeight,
  maxHeight = 480,
  itemKey,
  render,
  label,
  testId,
  threshold = VIRTUAL_THRESHOLD,
  scrollToIndex = null,
}: {
  items: readonly T[];
  rowHeight: number;
  maxHeight?: number;
  itemKey: (item: T) => string;
  render: (item: T) => ReactNode;
  label: string;
  testId?: string;
  threshold?: number;
  /** Keeps this row inside the scroll box when virtualized (below the threshold the page scrolls). */
  scrollToIndex?: number | null;
}) {
  const [top, setTop] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || scrollToIndex === null) return;
    const y = scrollToIndex * rowHeight;
    if (y < box.scrollTop) box.scrollTop = y;
    else if (y + rowHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = y + rowHeight - box.clientHeight;
    setTop(box.scrollTop);
  }, [scrollToIndex, rowHeight]);
  if (items.length <= threshold) {
    return (
      <ul aria-label={label} data-testid={testId} className="m-0 list-none p-0">
        {items.map((it) => (
          <li key={itemKey(it)} style={{ height: rowHeight }} className="border-b border-border">
            {render(it)}
          </li>
        ))}
      </ul>
    );
  }
  const over = 6;
  const first = Math.max(0, Math.floor(top / rowHeight) - over);
  const last = Math.min(items.length, Math.ceil((top + maxHeight) / rowHeight) + over);
  return (
    <div
      ref={boxRef}
      style={{ maxHeight, overflowY: "auto" }}
      tabIndex={0}
      aria-label={`${label} (scrollable)`}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      data-virtual="true"
    >
      <ul
        aria-label={label}
        data-testid={testId}
        className="relative m-0 list-none p-0"
        style={{ height: items.length * rowHeight }}
      >
        {items.slice(first, last).map((it, i) => (
          <li
            key={itemKey(it)}
            aria-setsize={items.length}
            aria-posinset={first + i + 1}
            className="absolute inset-x-0 border-b border-border"
            style={{ top: (first + i) * rowHeight, height: rowHeight }}
          >
            {render(it)}
          </li>
        ))}
      </ul>
    </div>
  );
}
