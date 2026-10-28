import { useEffect, useId, useState } from "react";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { moveSession } from "../atlas/actions";
import { atlasApi } from "../atlas/api";
import { atlasOf, type ProjectSummary } from "../atlas/types";
import { displayNameOf } from "../lib/attention";

const INFER = "__infer__";

/**
 * "Move to project": reassigns one session (PATCH /sessions/:id/project). The control always
 * renders the same select; `projects` may be passed in, or are loaded once on mount.
 * Choosing "Re-infer" clears the manual assignment.
 */
export function MoveToProject({
  session,
  projects,
  onMoved,
  className = "w-44",
}: {
  session: SessionSnapshot;
  projects?: ProjectSummary[] | null;
  onMoved?: () => void;
  className?: string;
}) {
  const id = useId();
  const [own, setOwn] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const a = atlasOf(session);
  const list = projects ?? own ?? [];
  const known = list.some((p) => p.id === a.project_id);
  const hasProjects = projects != null;
  useEffect(() => {
    if (hasProjects) return;
    let alive = true;
    atlasApi.listProjects().then(
      (l) => alive && setOwn(l),
      () => alive && setError("Could not load projects"),
    );
    return () => {
      alive = false;
    };
  }, [hasProjects]);
  const change = (value: string) => {
    setBusy(true);
    setError(null);
    moveSession(session.session_id, value === INFER ? null : value).then(
      () => {
        setBusy(false);
        onMoved?.();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : "Move failed");
      },
    );
  };
  return (
    <span className="relative inline-flex items-center gap-s-1" data-testid="move-to-project">
      <label htmlFor={id} className="sr-only">
        Move {displayNameOf(session)} to project
      </label>
      <select
        id={id}
        value={a.project_id ?? ""}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        className={`${className} rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg`}
      >
        <option value="" disabled>
          Move to project…
        </option>
        {!known && a.project_id ? (
          <option value={a.project_id}>{a.project_name ?? a.project_id}</option>
        ) : null}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.project_dir}
          </option>
        ))}
        <option value={INFER}>Clear manual assignment (re-infer)</option>
      </select>
      {error ? (
        <span
          role="alert"
          className="absolute left-0 top-full z-10 mt-0.5 whitespace-nowrap rounded border border-state-error bg-surface-1 px-s-2 text-xs text-state-error"
        >
          <span aria-hidden="true">✖ </span>
          {error}
        </span>
      ) : null}
    </span>
  );
}
