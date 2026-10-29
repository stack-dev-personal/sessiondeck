import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useAccountUsage } from "../hooks/useAccountUsage";
import { useNow } from "../hooks/useNow";
import { formatClock, formatReset } from "../lib/format";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import { Meter, windowModel } from "./Meter";

/** Geometry the drag math needs; the markup uses the same numbers via inline style. */
export const WIDGET_SIZE = 176;
/**
 * Chip content math (px): padding 8*2 + border 2 + button 24 + ring/slack 6 = 48 tall;
 * 8*2 + 2 + handle 32 + gap 4 + label button (16 + 2 + 17 chars of 11px mono ~ 112) = 184, plus slack.
 */
export const CHIP_W = 200;
export const CHIP_H = 48;
export const CHIP_MIN = { w: 184, h: 42 };
export const MARGIN = 16;
export const KEY_STEP = 8;
export const KEY_STEP_BIG = 64;

export interface Pos {
  x: number;
  y: number;
}
export interface Stored {
  pos: Pos | null;
  collapsed: boolean;
}

const sizeOf = (collapsed: boolean) =>
  collapsed ? { w: CHIP_W, h: CHIP_H } : { w: WIDGET_SIZE, h: WIDGET_SIZE };

/** Keep the whole box inside the viewport (top-left wins when the viewport is smaller). */
export function clampPos(p: Pos, collapsed: boolean, vw: number, vh: number): Pos {
  const { w, h } = sizeOf(collapsed);
  return {
    x: Math.max(0, Math.min(p.x, vw - w)),
    y: Math.max(0, Math.min(p.y, vh - h)),
  };
}

export function defaultPos(collapsed: boolean, vw: number, vh: number): Pos {
  const { w, h } = sizeOf(collapsed);
  return clampPos({ x: vw - w - MARGIN, y: vh - h - MARGIN }, collapsed, vw, vh);
}

/** Corrupt, partial or unreadable storage falls back to the default corner, expanded. */
export function loadStored(): Stored {
  const raw = readStored(STORAGE_KEYS.usageWidget);
  if (raw === null) return { pos: null, collapsed: false };
  try {
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return { pos: null, collapsed: false };
    const o = p as Record<string, unknown>;
    const x = o["x"];
    const y = o["y"];
    const pos =
      typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
        ? { x, y }
        : null;
    return { pos, collapsed: o["collapsed"] === true };
  } catch {
    return { pos: null, collapsed: false };
  }
}

function absolute(resetsAt: number, now: number): string {
  const clock = formatClock(resetsAt);
  if (resetsAt - now < 86_400_000) return clock;
  return `${new Date(resetsAt).toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
}

function Reset({ resetsAt, now, id }: { resetsAt: number | null; now: number; id: string }) {
  const stale = resetsAt !== null && now >= resetsAt;
  const rel = resetsAt === null ? null : stale ? null : formatReset(resetsAt, now);
  return (
    <div data-slot={`${id}-reset`} className="num min-w-0 truncate text-xs text-fg-muted">
      {rel === null ? "resets n/a" : `resets ${rel} · ${absolute(resetsAt!, now)}`}
    </div>
  );
}

function pctText(pct: number | null) {
  return pct === null ? "n/a" : `${Math.round(pct)}%`;
}

/**
 * Account usage: 5-hour and 7-day used percentage with reset times, from the freshest statusLine
 * rate_limits across sessions. Floating, draggable (pointer capture) and keyboard-movable
 * (arrows, Shift for a larger step); collapses to a chip. Position and collapsed state persist
 * per browser. Only the two documented windows are shown.
 */
export function UsageWidget() {
  const usage = useAccountUsage();
  const now = useNow();
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [state, setState] = useState<Stored>(() => {
    const st = loadStored();
    return {
      ...st,
      pos: st.pos && clampPos(st.pos, st.collapsed, window.innerWidth, window.innerHeight),
    };
  });
  const { collapsed } = state;
  const pos = clampPos(state.pos ?? defaultPos(collapsed, vp.w, vp.h), collapsed, vp.w, vp.h);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const lastDrag = useRef<Pos | null>(null);
  const bodyId = useId();
  const hintId = useId();

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persist = useCallback((p: Pos | null, c: boolean) => {
    writeStored(STORAGE_KEYS.usageWidget, JSON.stringify({ x: p?.x, y: p?.y, collapsed: c }));
  }, []);

  const moveTo = (p: Pos, commit: boolean) => {
    const next = clampPos(p, collapsed, window.innerWidth, window.innerHeight);
    lastDrag.current = next;
    setState((s) => ({ ...s, pos: next }));
    if (commit) persist(next, collapsed);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    drag.current = { dx: e.clientX - posRef.current.x, dy: e.clientY - posRef.current.y };
    lastDrag.current = null;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    moveTo({ x: e.clientX - d.dx, y: e.clientY - d.dy }, false);
  };
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (lastDrag.current) persist(lastDrag.current, collapsed);
    lastDrag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const d: Record<string, Pos> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    moveTo({ x: posRef.current.x + v.x, y: posRef.current.y + v.y }, true);
  };

  const toggle = () => {
    const c = !collapsed;
    const next = clampPos(posRef.current, c, window.innerWidth, window.innerHeight);
    setState({ pos: next, collapsed: c });
    persist(next, c);
  };

  const five = windowModel("five_hour", usage?.five_hour ?? null, now);
  const seven = windowModel("seven_day", usage?.seven_day ?? null, now);
  const reported = usage !== null;
  const { w, h } = sizeOf(collapsed);

  const handle = (
    <button
      type="button"
      data-testid="usage-handle"
      aria-label="Move usage widget"
      aria-describedby={hintId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      style={{ touchAction: "none" }}
      className="num flex h-6 shrink-0 cursor-grab items-center rounded border border-border-control px-s-2 text-xs text-fg-muted active:cursor-grabbing"
    >
      <span aria-hidden="true">⠿</span>
    </button>
  );
  const toggleBtn = (label: string, text: string) => (
    <button
      type="button"
      data-testid="usage-collapse"
      aria-expanded={!collapsed}
      aria-controls={collapsed ? undefined : bodyId}
      aria-label={label}
      onClick={toggle}
      className="num flex h-6 min-w-0 items-center rounded border border-border-control px-s-2 text-xs text-fg"
    >
      {text}
    </button>
  );

  return (
    <aside
      data-testid="usage-widget"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Account usage"
      style={{ position: "fixed", left: pos.x, top: pos.y, width: w, height: h }}
      className="z-20 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-2 p-s-2 text-sm text-fg"
    >
      <span id={hintId} className="sr-only">
        Arrow keys move, Shift for larger steps
      </span>
      {collapsed ? (
        <div className="flex min-w-0 items-center gap-s-1">
          {handle}
          {toggleBtn(
            "Expand usage widget",
            `5h ${pctText(reported ? five.pct : null)} · 7d ${pctText(reported ? seven.pct : null)}`,
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-s-2">
            <span className="text-xs uppercase text-fg-muted">Usage</span>
            <span className="flex gap-s-1">
              {handle}
              {toggleBtn("Collapse usage widget", "–")}
            </span>
          </div>
          <div id={bodyId} className="mt-s-2 flex min-h-0 flex-1 flex-col justify-between">
            {reported ? (
              <>
                <section data-slot="five_hour" aria-label="5 hour window">
                  <Meter m={five} />
                  <Reset resetsAt={usage.five_hour?.resets_at ?? null} now={now} id="five_hour" />
                </section>
                <section data-slot="seven_day" aria-label="7 day window">
                  <Meter m={seven} />
                  <Reset resetsAt={usage.seven_day?.resets_at ?? null} now={now} id="seven_day" />
                </section>
              </>
            ) : (
              <p data-testid="usage-empty" className="text-xs text-fg-muted">
                Usage not reported yet
              </p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
