import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useProjects } from "../atlas/useProjects";
import { formatCount } from "../atlas/format";
import type { ProjectSummary } from "../atlas/types";
import { FixedList } from "../components/FixedList";
import { ProjectSwatch } from "../components/ProjectSwatch";

const COLS = "grid grid-cols-[1rem_minmax(8rem,1fr)_minmax(0,2fr)_6rem_6rem] items-center gap-s-3";

export function sortProjects(list: readonly ProjectSummary[]): ProjectSummary[] {
  return [...list].sort(
    (a, b) => b.live - a.live || (a.name || a.project_dir).localeCompare(b.name || b.project_dir),
  );
}

function Row({ p }: { p: ProjectSummary }) {
  return (
    <div
      className={`${COLS} h-full px-s-3 text-sm`}
      data-testid="project-row"
      data-project-id={p.id}
    >
      <ProjectSwatch color={p.color} />
      <Link
        to={`/projects/${encodeURIComponent(p.id)}`}
        className="min-w-0 truncate text-accent underline"
      >
        {p.name || p.project_dir}
      </Link>
      <span className="num min-w-0 truncate text-fg-faint" title={p.project_dir}>
        {p.project_dir}
      </span>
      <span className="num text-right" data-slot="sessions">
        {formatCount(p.sessions)}
      </span>
      <span className="num text-right" data-slot="live">
        {formatCount(p.live)}
      </span>
    </div>
  );
}

/** /projects: every project with its color, session count and live count. */
export function Projects() {
  const { data, error, loading } = useProjects();
  const rows = useMemo(() => sortProjects(data ?? []), [data]);
  return (
    <section aria-labelledby="projects-h" className="mx-auto flex max-w-5xl flex-col gap-s-3 p-s-4">
      <h1 id="projects-h" className="m-0 text-xl font-normal">
        Projects
      </h1>
      <p role="status" data-testid="projects-count" className="num m-0 text-sm text-fg-muted">
        {error ? (
          <span className="text-state-error">
            <span aria-hidden="true">✖ </span>
            {error}
          </span>
        ) : loading && data === null ? (
          "Loading…"
        ) : (
          `${rows.length} ${rows.length === 1 ? "project" : "projects"}`
        )}
      </p>
      <div className="rounded-lg border border-border bg-surface-1">
        <div
          className={`${COLS} border-b border-border px-s-3 py-s-1 text-xs uppercase tracking-wide text-fg-muted`}
          aria-hidden="true"
        >
          <span />
          <span>Name</span>
          <span>Directory</span>
          <span className="text-right">Sessions</span>
          <span className="text-right">Live</span>
        </div>
        {rows.length === 0 ? (
          <p className="m-0 px-s-3 py-s-3 text-sm text-fg-muted">
            {loading && data === null
              ? "Loading…"
              : "No projects yet. They appear when the first session reports."}
          </p>
        ) : (
          <FixedList
            label="Projects"
            testId="projects-list"
            items={rows}
            rowHeight={40}
            itemKey={(p) => p.id}
            render={(p) => <Row p={p} />}
          />
        )}
      </div>
    </section>
  );
}
