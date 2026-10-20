import { useMemo } from "react";
import { selectProjects } from "../lib/attention";
import { selectHosts, useBoard } from "../store/board";
import { useFilters } from "../store/filters";

const select =
  "w-48 max-w-full rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg";

/** A persisted filter value that no session has right now stays selectable so it can be undone. */
function withCurrent(options: string[], current: string | null): string[] {
  return current !== null && !options.includes(current) ? [...options, current].sort() : options;
}

/**
 * Host and project filters plus the count. Always rendered with the same controls (the clear
 * button is disabled, not removed), so the toolbar never changes height or shifts the grid.
 */
export function BoardToolbar({
  shown,
  total,
  hiddenAttention,
}: {
  shown: number;
  total: number;
  hiddenAttention: number;
}) {
  const sessions = useBoard((s) => s.sessions);
  const host = useFilters((s) => s.host);
  const project = useFilters((s) => s.project);
  const { setHost, setProject, clear } = useFilters.getState();
  const hosts = useMemo(() => withCurrent(selectHosts(sessions), host), [sessions, host]);
  const projects = useMemo(
    () => withCurrent(selectProjects(sessions), project),
    [sessions, project],
  );
  const active = host !== null || project !== null;
  return (
    <div
      role="group"
      aria-label="Board filters"
      data-testid="board-toolbar"
      className="flex flex-wrap items-center gap-x-s-3 gap-y-s-2 border-b border-border px-s-4 py-s-2 text-sm"
    >
      <span className="flex items-center gap-s-2 text-fg-muted">
        <label htmlFor="board-filter-host">Host</label>
        <select
          id="board-filter-host"
          className={select}
          value={host ?? ""}
          onChange={(e) => setHost(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">All hosts</option>
          {hosts.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </span>
      <span className="flex items-center gap-s-2 text-fg-muted">
        <label htmlFor="board-filter-project">Project</label>
        <select
          id="board-filter-project"
          className={select}
          value={project ?? ""}
          onChange={(e) => setProject(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </span>
      <button
        type="button"
        onClick={clear}
        disabled={!active}
        className="rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-fg enabled:hover:bg-surface-3 disabled:text-fg-faint"
      >
        Clear filters
      </button>
      <span
        role="status"
        data-testid="board-hidden-attention-region"
        className={hiddenAttention > 0 ? "ml-auto" : ""}
      >
        {hiddenAttention > 0 ? (
          <span
            data-testid="board-hidden-attention"
            className="num flex items-center gap-s-1 font-medium text-state-waiting"
          >
            <span aria-hidden="true">▲</span>
            {hiddenAttention} hidden {hiddenAttention === 1 ? "needs" : "need"} attention
          </span>
        ) : null}
      </span>
      <span
        role="status"
        data-testid="board-count"
        className={`num text-fg-muted ${hiddenAttention > 0 ? "" : "ml-auto"}`}
      >
        {active
          ? `Showing ${shown} of ${total}`
          : `${total} ${total === 1 ? "session" : "sessions"}`}
      </span>
    </div>
  );
}
