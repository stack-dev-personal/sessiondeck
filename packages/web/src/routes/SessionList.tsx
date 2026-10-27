import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { SESSION_STATES } from "@sessiondeck/contract";
import { atlasApi } from "../atlas/api";
import { atlasOf, type AtlasSession } from "../atlas/types";
import { useLoad } from "../atlas/useProjects";
import { FixedList } from "../components/FixedList";
import { ProjectSwatch } from "../components/ProjectSwatch";
import { StateChip } from "../components/StateChip";
import { useNow } from "../hooks/useNow";
import { displayNameOf, projectOf } from "../lib/attention";
import { formatDuration } from "../lib/format";
import { shouldIgnoreKey } from "../lib/keys";
import {
  RANGES,
  RANGE_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  activeFilterCount,
  applyListQuery,
  listQueryParams,
  mergeSessions,
  parseListQuery,
  type ListQuery,
} from "../lib/sessionList";
import { STATE_VOCAB } from "../lib/state-vocab";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

const ROW_H = 44;
const COLS =
  "grid grid-cols-[minmax(8rem,10rem)_minmax(10rem,1.4fr)_minmax(8rem,1fr)_minmax(5rem,7rem)_minmax(6rem,8rem)_5.5rem_7.5rem] items-center gap-s-3";
const ctl =
  "rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg disabled:text-fg-faint";
const btn = `${ctl} hover:bg-surface-3`;

const pad = (n: number) => String(n).padStart(2, "0");
function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs uppercase tracking-wide text-fg-muted">
      {label}
      {children}
    </label>
  );
}

function Row({
  s,
  now,
  selected,
  tabbable,
  onPick,
}: {
  s: AtlasSession;
  now: number;
  selected: boolean;
  /** The one row in the tab order: the selected one, else the first. */
  tabbable: boolean;
  onPick: (id: string) => void;
}) {
  const a = atlasOf(s);
  const name = displayNameOf(s);
  const branch = s.git.branch;
  const known = (STATE_VOCAB as Record<string, unknown>)[s.state] !== undefined;
  return (
    <div
      data-testid="session-list-row"
      data-session-id={s.session_id}
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onPick(s.session_id)}
      className={`${COLS} h-full cursor-pointer border-l-4 px-s-3 text-sm ${
        selected
          ? "border-accent bg-surface-2 outline outline-2 -outline-offset-2 outline-accent"
          : "border-transparent hover:bg-surface-2"
      }`}
    >
      {known ? (
        <StateChip state={s.state} />
      ) : (
        <span className="num truncate text-fg-muted">{s.state}</span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate" title={name}>
          {name}
        </span>
        <span className="num truncate text-xs text-fg-muted" title={`${s.host} ${s.session_id}`}>
          {s.host}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-s-2" data-slot="project">
        <ProjectSwatch color={a.project_color} />
        <span className="truncate">{a.project_name ?? projectOf(s)}</span>
      </span>
      <span className="num truncate" data-slot="phase" title={a.phase ?? undefined}>
        {a.phase ?? <span className="text-fg-muted">n/a</span>}
      </span>
      <span className="num truncate text-fg-muted" data-slot="branch" title={branch ?? undefined}>
        {branch ?? "n/a"}
      </span>
      <span className="num text-right" data-slot="activity" title={formatStamp(s.last_event_at)}>
        {s.last_event_at > 0 ? `${formatDuration(now - s.last_event_at)} ago` : "n/a"}
      </span>
      <span className="num text-right text-fg-muted" data-slot="started">
        {s.started_at > 0 ? formatStamp(s.started_at) : "n/a"}
      </span>
    </div>
  );
}

/**
 * /sessions: every session the hub keeps (ended and archived included) merged with the live board.
 * Filters and sort live in the URL query. j/k move the selection, Enter opens the detail drawer,
 * Escape clears the selection, / focuses the filter box.
 */
export function SessionList() {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parseListQuery(params), [params]);
  const hub = useLoad(() => atlasApi.listSessions(), "sessions");
  const boardSessions = useBoard((s) => s.sessions);
  const now = useNow();
  const openSession = useUi((u) => u.openSession);
  const [selId, setSelId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef(false);

  const all = useMemo(
    () => mergeSessions(hub.data, boardSessions as Record<string, AtlasSession>),
    [hub.data, boardSessions],
  );
  const rows = useMemo(() => applyListQuery(all, query, now), [all, query, now]);
  const selIdx = selId === null ? -1 : rows.findIndex((r) => r.session_id === selId);

  const update = useCallback(
    (patch: Partial<ListQuery>) => {
      setParams((cur) => listQueryParams({ ...parseListQuery(cur), ...patch }, cur), {
        replace: true,
      });
    },
    [setParams],
  );

  // Options come from the data, plus whatever the URL already asks for (a link may precede the data).
  const options = useMemo(() => {
    const hosts = new Set<string>();
    const projects = new Map<string, string>();
    const phases = new Set<string>();
    for (const s of all) {
      const a = atlasOf(s);
      hosts.add(s.host);
      if (a.project_id) projects.set(a.project_id, a.project_name ?? a.project_id);
      if (a.phase) phases.add(a.phase);
    }
    if (query.host) hosts.add(query.host);
    if (query.project && !projects.has(query.project)) projects.set(query.project, query.project);
    if (query.phase) phases.add(query.phase);
    return {
      hosts: [...hosts].sort(),
      projects: [...projects].sort((a, b) => a[1].localeCompare(b[1])),
      phases: [...phases].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    };
  }, [all, query.host, query.project, query.phase]);

  const pick = useCallback(
    (id: string) => {
      setSelId(id);
      const row = all.find((r) => r.session_id === id);
      const onBoard = useBoard.getState().sessions[id] !== undefined;
      openSession(id, onBoard ? undefined : row);
    },
    [all, openSession],
  );

  // /sessions?open=<id> (the palette, for a session the board does not hold): select it, open the drawer.
  const openParam = params.get("open");
  useEffect(() => {
    if (openParam === null || (hub.loading && hub.data === null)) return;
    const row = all.find((r) => r.session_id === openParam);
    if (row) {
      setSelId(openParam);
      openSession(openParam, useBoard.getState().sessions[openParam] ? undefined : row);
      setNote(null);
    } else {
      setNote(`Session ${openParam} not found`);
    }
    setParams((cur) => listQueryParams(parseListQuery(cur)), { replace: true });
  }, [openParam, hub.loading, hub.data, all, openSession, setParams]);

  // Keyboard: j/k, Enter, Escape, /. shouldIgnoreKey covers typing, modifiers, the drawer and the palette.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selRef = useRef(selId);
  selRef.current = selId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e)) return;
      const list = rowsRef.current;
      const cur = list.findIndex((r) => r.session_id === selRef.current);
      const go = (i: number) => {
        const row = list[i];
        if (!row) return;
        e.preventDefault();
        pendingFocus.current = true;
        setSelId(row.session_id);
      };
      if (e.key === "j") go(cur === -1 ? 0 : Math.min(list.length - 1, cur + 1));
      else if (e.key === "k") go(cur === -1 ? list.length - 1 : Math.max(0, cur - 1));
      else if (e.key === "Enter") {
        const t = e.target;
        const onControl = t instanceof HTMLElement && t.closest("button, a, summary") !== null;
        const row = list[cur];
        if (row && !onControl) {
          e.preventDefault();
          pick(row.session_id);
        }
      } else if (e.key === "Escape") {
        if (selRef.current !== null) {
          e.preventDefault();
          setSelId(null);
          const a = document.activeElement;
          if (a instanceof HTMLElement && a.dataset["testid"] === "session-list-row") a.blur();
        }
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick]);

  // Move DOM focus to the selected row after a j/k (the row may only exist once the virtual list scrolled).
  useEffect(() => {
    if (!pendingFocus.current || selId === null) return;
    const el = document.querySelector<HTMLElement>(
      `[data-testid="session-list-row"][data-session-id="${CSS.escape(selId)}"]`,
    );
    if (el) {
      pendingFocus.current = false;
      el.focus();
      el.scrollIntoView?.({ block: "nearest" });
    }
  });

  const filters = activeFilterCount(query);
  const countText =
    hub.loading && hub.data === null && all.length === 0
      ? "Loading…"
      : `${rows.length} of ${all.length} sessions`;
  return (
    <section
      aria-labelledby="sessions-h"
      className="mx-auto flex max-w-[90rem] flex-col gap-s-3 p-s-4"
    >
      <h1 id="sessions-h" className="m-0 text-xl font-normal">
        Sessions
      </h1>
      <div
        role="search"
        aria-label="Filter sessions"
        className="flex flex-wrap items-end gap-s-3"
        data-testid="session-filters"
      >
        <Field label="Filter">
          <input
            ref={searchRef}
            type="search"
            aria-label="Filter sessions by text (/)"
            placeholder="name, project, branch (/)"
            value={query.q}
            onChange={(e) => update({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              if (query.q !== "") update({ q: "" });
              else e.currentTarget.blur();
            }}
            className={`${ctl} w-56`}
          />
        </Field>
        <Field label="Host">
          <select
            value={query.host ?? ""}
            onChange={(e) => update({ host: e.target.value || null })}
            className={ctl}
          >
            <option value="">All hosts</option>
            {options.hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project">
          <select
            value={query.project ?? ""}
            onChange={(e) => update({ project: e.target.value || null })}
            className={ctl}
          >
            <option value="">All projects</option>
            {options.projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phase">
          <select
            value={query.phase ?? ""}
            onChange={(e) => update({ phase: e.target.value || null })}
            className={ctl}
          >
            <option value="">All phases</option>
            {options.phases.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State">
          <select
            value={query.state ?? ""}
            onChange={(e) => update({ state: (e.target.value || null) as ListQuery["state"] })}
            className={ctl}
          >
            <option value="">All states</option>
            {SESSION_STATES.map((st) => (
              <option key={st} value={st}>
                {(STATE_VOCAB as Record<string, { label: string } | undefined>)[st]?.label ?? st}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <select
            value={query.range}
            onChange={(e) => update({ range: e.target.value as ListQuery["range"] })}
            className={ctl}
          >
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {RANGE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sort">
          <select
            value={query.sort}
            onChange={(e) => update({ sort: e.target.value as ListQuery["sort"] })}
            className={ctl}
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className={btn}
          disabled={filters === 0}
          onClick={() =>
            update({ host: null, project: null, phase: null, state: null, range: "all", q: "" })
          }
        >
          Clear filters{filters > 0 ? ` (${filters})` : ""}
        </button>
        <button type="button" className={btn} onClick={hub.reload}>
          Refresh
        </button>
      </div>
      <p
        role="status"
        data-testid="sessions-count"
        className="num m-0 min-h-[1.45em] text-sm text-fg-muted"
      >
        {hub.error ? (
          <span className="text-state-error">
            <span aria-hidden="true">✖ </span>
            {hub.error} (showing live sessions only)
          </span>
        ) : (
          countText
        )}
        {note ? ` · ${note}` : ""}
      </p>
      <div className="rounded-lg border border-border bg-surface-1">
        <div
          aria-hidden="true"
          className={`${COLS} border-b border-border px-s-3 py-s-1 pl-[calc(var(--s-3)+4px)] text-xs uppercase tracking-wide text-fg-muted`}
        >
          <span>State</span>
          <span>Session</span>
          <span>Project</span>
          <span>Phase</span>
          <span>Branch</span>
          <span className="text-right">Active</span>
          <span className="text-right">Started</span>
        </div>
        {rows.length === 0 ? (
          <p className="m-0 p-s-3 text-sm text-fg-muted" data-testid="sessions-empty">
            {all.length === 0 ? "No sessions yet." : "No sessions match the filters."}
          </p>
        ) : (
          <FixedList
            items={rows}
            rowHeight={ROW_H}
            maxHeight={Math.max(
              360,
              (typeof window === "undefined" ? 900 : window.innerHeight) - 300,
            )}
            itemKey={(s) => s.session_id}
            label="Sessions"
            testId="session-list"
            scrollToIndex={selIdx === -1 ? null : selIdx}
            render={(s) => (
              <Row
                s={s}
                now={now}
                selected={s.session_id === selId}
                tabbable={selIdx === -1 ? s === rows[0] : s.session_id === selId}
                onPick={pick}
              />
            )}
          />
        )}
      </div>
    </section>
  );
}
