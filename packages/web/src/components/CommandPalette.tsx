import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { atlasApi, isAbort } from "../atlas/api";
import type { SearchKind, SearchResult } from "../atlas/types";
import { Highlighted, queryTokens } from "../lib/highlight";
import { STATE_VOCAB } from "../lib/state-vocab";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

/** Quiet period after the last keystroke before a search request goes out. */
export const SEARCH_DEBOUNCE_MS = 40;
const LIMIT = 20;
/** Text longer than this is cut before it is rendered; transcript text can be huge. */
const MAX_TEXT = 240;

const GROUPS: ReadonlyArray<{ kind: SearchKind; label: string; glyph: string }> = [
  { kind: "session", label: "Sessions", glyph: "▶" },
  { kind: "project", label: "Projects", glyph: "▣" },
  { kind: "phase", label: "Phases", glyph: "◆" },
];

/** Where focus goes when the palette closes: the element focused when it opened. */
let returnTo: HTMLElement | null = null;

/** Opens the palette from anywhere; remembers the focused element for the way back. */
export function openPalette(): void {
  if (!useUi.getState().paletteOpen) {
    const a = document.activeElement;
    returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
  }
  useUi.getState().setPaletteOpen(true);
}

export function closePalette(): void {
  useUi.getState().setPaletteOpen(false);
}

/** Ctrl+K (Cmd+K on macOS) opens the palette wherever focus is, including inside a text field. */
function usePaletteHotkey(): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k")
        return;
      e.preventDefault();
      if (!e.repeat) openPalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Always mounted; renders the dialog only while open. */
export function CommandPalette() {
  usePaletteHotkey();
  const open = useUi((s) => s.paletteOpen);
  return open ? createPortal(<PaletteDialog />, document.body) : null;
}

type Status = "loading" | "ready" | "error";
interface Shown {
  status: Status;
  /** The query the visible results answer. */
  forQuery: string | null;
  results: SearchResult[];
  error: string | null;
  tookMs: number | null;
  roundTripMs: number | null;
}

const clip = (t: string): string => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t);

/** The visible order: grouped by kind (Sessions, Projects, Phases), hub order inside a group. */
export function groupResults(results: readonly SearchResult[]) {
  return GROUPS.map((g) => ({ ...g, items: results.filter((r) => r.kind === g.kind) })).filter(
    (g) => g.items.length > 0,
  );
}

function PaletteDialog() {
  const navigate = useNavigate();
  const uid = useId();
  const listId = `${uid}-list`;
  const titleId = `${uid}-title`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  /** Bumped by Enter after a failed search: runs the same query again. */
  const [retry, setRetry] = useState(0);
  const [shown, setShown] = useState<Shown>({
    status: "loading",
    forQuery: null,
    results: [],
    error: null,
    tookMs: null,
    roundTripMs: null,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dispatchedAt = useRef(0);
  /** Enter pressed while the results on screen answer an older query: open the first hit on arrival. */
  const pendingEnter = useRef(false);
  const jumpRef = useRef<(r: SearchResult) => void>(() => {});

  // Everything behind the dialog is inert while it is open; focus returns to where it came from.
  useEffect(() => {
    const root = document.getElementById("root");
    const wasInert = root?.hasAttribute("inert") ?? true;
    if (root && !wasInert) root.setAttribute("inert", "");
    inputRef.current?.focus();
    return () => {
      if (root && !wasInert) root.removeAttribute("inert");
      const back = returnTo;
      returnTo = null;
      if (back && back.isConnected) back.focus();
    };
  }, []);

  // Debounced search. Each run owns an AbortController and an `alive` flag: a response that arrives
  // after a newer query was typed is dropped, never rendered over the newer one.
  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    pendingEnter.current = false;
    const run = () => {
      dispatchedAt.current = performance.now();
      setShown((s) => ({ ...s, status: "loading" }));
      atlasApi.search(q, { limit: LIMIT, signal: ctrl.signal }).then(
        (r) => {
          if (!alive) return;
          const rt = performance.now() - dispatchedAt.current;
          setShown({
            status: "ready",
            forQuery: q,
            results: r.results,
            error: null,
            tookMs: r.took_ms,
            roundTripMs: rt,
          });
          setActive(0);
          if (pendingEnter.current) {
            pendingEnter.current = false;
            const first = groupResults(r.results)[0]?.items[0];
            if (first) jumpRef.current(first);
          }
        },
        (e: unknown) => {
          if (!alive || isAbort(e)) return;
          pendingEnter.current = false;
          setShown((s) => ({
            ...s,
            status: "error",
            error: e instanceof Error ? e.message : "Search failed",
          }));
        },
      );
    };
    const timer = setTimeout(run, q.trim() === "" ? 0 : SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, retry]);

  // Request dispatch to results committed. Recorded as a User Timing measure so a browser test can
  // read the real number (performance.getEntriesByName("sd-palette-search")).
  useEffect(() => {
    if (shown.status !== "ready") return;
    try {
      performance.measure("sd-palette-search", {
        start: dispatchedAt.current,
        end: performance.now(),
        detail: { q: shown.forQuery, tookMs: shown.tookMs, results: shown.results.length },
      });
    } catch {
      /* User Timing unavailable: the measure is a diagnostic only */
    }
  }, [shown]);

  const groups = useMemo(() => groupResults(shown.results), [shown.results]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const tokens = useMemo(() => queryTokens(shown.forQuery ?? q), [shown.forQuery, q]);
  const activeIdx = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => {
    document.getElementById(optId(activeIdx))?.scrollIntoView?.({ block: "nearest" });
    // optId is derived from uid, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, flat]);

  const jump = useCallback(
    (r: SearchResult) => {
      closePalette();
      if (r.kind === "project") {
        navigate(`/projects/${encodeURIComponent(r.id)}`);
      } else if (r.kind === "phase") {
        const p = new URLSearchParams({ project: r.project_id, phase: r.id });
        navigate(`/sessions?${p.toString()}`);
      } else if (useBoard.getState().sessions[r.id] !== undefined) {
        useUi.getState().openSession(r.id);
      } else {
        navigate(`/sessions?open=${encodeURIComponent(r.id)}`);
      }
    },
    [navigate],
  );

  jumpRef.current = jump;

  const move = (d: 1 | -1) =>
    setActive(flat.length === 0 ? 0 : (activeIdx + d + flat.length) % flat.length);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    let handled = true;
    if (e.key === "Escape") closePalette();
    else if (e.key === "ArrowDown" || (ctrl && e.key.toLowerCase() === "n")) move(1);
    else if (e.key === "ArrowUp" || (ctrl && e.key.toLowerCase() === "p")) move(-1);
    else if (e.key === "Enter") {
      if (shown.status === "error") setRetry((n) => n + 1);
      else if (shown.forQuery !== q) {
        // The list on screen answers an older query: wait for the current one, then open its first hit.
        pendingEnter.current = true;
      } else {
        const r = flat[activeIdx];
        if (r) jump(r);
      }
    } else if (e.key === "Tab")
      inputRef.current?.focus(); // one tab stop: the input
    else handled = false;
    if (handled) {
      e.preventDefault();
      // Keep the drawer's document-level Escape and Tab trap out of this.
      e.stopPropagation();
    }
  };

  const busy = shown.status === "loading";
  const statusText =
    shown.status === "error"
      ? null
      : busy && shown.forQuery === null
        ? "Searching…"
        : flat.length === 0 && shown.status === "ready"
          ? "No results"
          : `${flat.length} ${flat.length === 1 ? "result" : "results"}`;
  let flatIndex = -1;
  return (
    <>
      <div aria-hidden="true" className="sd-scrim fixed inset-0 z-50" onClick={closePalette} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="command-palette"
        data-results-for={shown.forQuery ?? ""}
        data-status={shown.status}
        data-took-ms={shown.tookMs ?? ""}
        onKeyDown={onKeyDown}
        className="fixed left-1/2 top-[12vh] z-50 flex w-[min(40rem,92vw)] -translate-x-1/2 flex-col rounded-lg border border-border-strong bg-surface-1 text-sm"
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search sessions, projects and phases"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat.length > 0 ? optId(activeIdx) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search sessions, projects, phases"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded-t-lg border-0 border-b border-border bg-surface-1 px-s-3 py-s-3 text-md text-fg placeholder:text-fg-muted"
        />
        <div className="h-80 overflow-y-auto" aria-busy={busy}>
          {shown.status === "error" ? (
            <p role="alert" className="m-0 p-s-3 text-state-error">
              <span aria-hidden="true">✖ </span>
              Search failed: {shown.error}. Press Enter to retry.
            </p>
          ) : null}
          {shown.status === "ready" && flat.length === 0 ? (
            <p className="m-0 p-s-3 text-fg-muted">
              {shown.forQuery === "" ? "Nothing yet." : "No results"}
            </p>
          ) : null}
          <div id={listId} role="listbox" aria-label="Results">
            {groups.map((g) => (
              <div key={g.kind} role="group" aria-labelledby={`${uid}-g-${g.kind}`}>
                <div
                  id={`${uid}-g-${g.kind}`}
                  className="sticky top-0 bg-surface-1 px-s-3 py-s-1 text-xs uppercase tracking-wide text-fg-muted"
                >
                  <span aria-hidden="true">{g.glyph} </span>
                  {g.label}
                  <span className="num"> · {g.items.length}</span>
                </div>
                {g.items.map((r) => {
                  const i = ++flatIndex;
                  const sel = i === activeIdx;
                  const v = r.state
                    ? (STATE_VOCAB as Record<string, (typeof STATE_VOCAB)["idle"] | undefined>)[
                        r.state
                      ]
                    : undefined;
                  return (
                    <div
                      key={`${r.kind}:${r.project_id}:${r.id}`}
                      id={optId(i)}
                      role="option"
                      aria-selected={sel}
                      data-kind={r.kind}
                      data-result-id={r.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => jump(r)}
                      className={`flex h-12 cursor-pointer flex-col justify-center border-l-2 px-s-3 ${
                        sel ? "border-accent bg-surface-2" : "border-transparent"
                      }`}
                    >
                      <span className="flex items-center gap-s-2">
                        <span className="min-w-0 flex-1 truncate">
                          <Highlighted text={clip(r.title) || "(untitled)"} tokens={tokens} />
                        </span>
                        {v ? (
                          <span className={`shrink-0 text-xs ${v.textClass}`}>
                            <span aria-hidden="true" className="num">
                              {v.glyph}{" "}
                            </span>
                            {v.label}
                          </span>
                        ) : null}
                        <span className="shrink-0 text-xs uppercase tracking-wide text-fg-muted">
                          {g.label.slice(0, -1)}
                        </span>
                      </span>
                      <span className="truncate text-xs text-fg-muted">
                        <Highlighted text={clip(r.snippet)} tokens={tokens} />
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-s-3 border-t border-border px-s-3 py-s-2 text-xs text-fg-muted">
          <span role="status" data-testid="palette-status">
            {statusText}
          </span>
          <span className="num" data-testid="palette-latency">
            {shown.tookMs !== null ? `hub ${shown.tookMs} ms` : "n/a"}
          </span>
          <span className="num">↑↓ move · Enter open · Esc close</span>
        </div>
      </div>
    </>
  );
}
