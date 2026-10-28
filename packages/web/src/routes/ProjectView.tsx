import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { atlasApi } from "../atlas/api";
import { COLOR_TOKENS, cssColor, isValidColor } from "../atlas/color";
import { formatCount, formatHours, formatTotalCost } from "../atlas/format";
import { ARCHIVED_CAP, mergeLive } from "../atlas/live";
import { atlasOf, type AtlasSession } from "../atlas/types";
import { useLoad, useProjects } from "../atlas/useProjects";
import { InlineEdit } from "../components/InlineEdit";
import { MoveToProject } from "../components/MoveToProject";
import { PhaseChip } from "../components/PhaseChip";
import { ProjectSwatch } from "../components/ProjectSwatch";
import { FixedList } from "../components/FixedList";
import { displayNameOf } from "../lib/attention";
import { STATE_VOCAB } from "../lib/state-vocab";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

const btn =
  "rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-sm text-fg hover:bg-surface-3 disabled:text-fg-faint";
const ctl = "rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg";

function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: string;
  children: ReactNode;
}) {
  const hid = `pv-${id}`;
  return (
    <section data-section={id} aria-labelledby={hid} className="flex flex-col gap-s-2">
      <h2 id={hid} className="m-0 flex items-baseline gap-s-2 text-lg font-normal">
        {title}
        {count !== undefined ? (
          <span data-slot="count" className="num text-sm text-fg-muted">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

/** Column captions for the session rows; visual only, each control has its own accessible name. */
function RowHead() {
  return (
    <div
      aria-hidden="true"
      className={`${ROW_GRID} border-b border-border px-s-3 py-s-1 text-xs uppercase tracking-wide text-fg-muted`}
    >
      <span>State</span>
      <span>Session</span>
      <span>Branch</span>
      <span>Phase</span>
      <span>Move to project</span>
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="m-0 rounded-lg border border-dashed border-border-strong px-s-3 py-s-3 text-sm text-fg-muted">
    {children}
  </p>
);

const ROW_H = 48;
const ROW_GRID =
  "grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)_minmax(0,14rem)_11rem_11.5rem] items-center gap-s-3";
const ROW = `${ROW_GRID} h-full px-s-3 text-sm`;

function stateCell(s: SessionSnapshot) {
  const v = STATE_VOCAB[s.state] as (typeof STATE_VOCAB)[keyof typeof STATE_VOCAB] | undefined;
  return v ? (
    <span className={`num truncate ${v.textClass}`} data-slot="state">
      <span aria-hidden="true">{v.glyph}</span> <span className="text-xs">{v.label}</span>
    </span>
  ) : (
    <span className="num truncate text-fg-muted" data-slot="state">
      {s.state}
    </span>
  );
}

function SessionRow({
  s,
  live,
  projects,
  onChanged,
}: {
  s: AtlasSession;
  live: boolean;
  projects: ReturnType<typeof useProjects>["data"];
  onChanged: () => void;
}) {
  const openSession = useUi((u) => u.openSession);
  const name = displayNameOf(s);
  const branch = s.git.branch ?? "n/a";
  const wt = s.git.worktree;
  const where = `${branch}${wt ? ` (worktree ${wt})` : ""}`;
  return (
    <div
      className={ROW}
      data-testid="project-session"
      data-session-id={s.session_id}
      data-live={live}
    >
      {stateCell(s)}
      {live ? (
        <button
          type="button"
          onClick={() => openSession(s.session_id)}
          aria-haspopup="dialog"
          title={`Open details: ${name}`}
          className="min-w-0 truncate text-left text-fg underline decoration-border-strong hover:decoration-fg"
        >
          {s.session_name ? `"${name}"` : name}
        </button>
      ) : (
        <span className="min-w-0 truncate" title={name}>
          {s.session_name ? `"${name}"` : name}
        </span>
      )}
      <span className="num min-w-0 truncate text-fg-muted" data-slot="where" title={where}>
        {where}
      </span>
      <PhaseChip session={s} onSaved={onChanged} />
      <MoveToProject session={s} projects={projects} onMoved={onChanged} className="w-full" />
    </div>
  );
}

function ColorPicker({ color, onPick }: { color: string; onPick: (c: string) => Promise<void> }) {
  const [hex, setHex] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (c: string) => {
    setBusy(true);
    setError(null);
    onPick(c).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : "Save failed");
      },
    );
  };
  const isToken = (COLOR_TOKENS as readonly string[]).includes(color);
  return (
    <fieldset
      className="m-0 flex flex-wrap items-center gap-s-2 border-0 p-0"
      data-testid="color-picker"
    >
      <legend className="sr-only">Project color</legend>
      <ProjectSwatch color={color} />
      <label htmlFor="pv-color-token" className="text-sm text-fg-muted">
        Color
      </label>
      <select
        id="pv-color-token"
        value={isToken ? color : ""}
        disabled={busy}
        onChange={(e) => e.target.value !== "" && run(e.target.value)}
        className={`${ctl} w-44`}
      >
        <option value="" disabled>
          {isToken ? "Token" : color ? `Custom ${color}` : "none"}
        </option>
        {COLOR_TOKENS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <label htmlFor="pv-color-hex" className="text-sm text-fg-muted">
        or #rrggbb
      </label>
      <input
        id="pv-color-hex"
        type="text"
        value={hex}
        maxLength={7}
        placeholder="#rrggbb"
        spellCheck={false}
        aria-invalid={hex !== "" && !isValidColor(hex) ? true : undefined}
        onChange={(e) => setHex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (isValidColor(hex)) run(hex);
            else setError("Use #rrggbb");
          }
        }}
        className={`${ctl} num w-28`}
      />
      <button
        type="button"
        className={btn}
        disabled={busy || hex === ""}
        onClick={() => (isValidColor(hex) ? run(hex) : setError("Use #rrggbb"))}
      >
        Set color
      </button>
      <span role="alert" data-slot="color-error" className="min-h-[1em] text-xs text-state-error">
        {error ? (
          <>
            <span aria-hidden="true">✖ </span>
            {error}
          </>
        ) : null}
      </span>
    </fieldset>
  );
}

/** /projects/:id. Live rows follow the realtime board; totals, branches, archived and phases come from REST. */
export function ProjectView() {
  const { id = "" } = useParams();
  const board = useBoard((s) => s.sessions);
  const memberKey = useMemo(
    () =>
      Object.values(board)
        .filter((s) => atlasOf(s).project_id === id)
        .map((s) => s.session_id)
        .sort()
        .join(","),
    [board, id],
  );
  const detail = useLoad(() => atlasApi.getProject(id), `${id}:${memberKey}`, id);
  const phases = useLoad(() => atlasApi.listPhases(id), `${id}:${memberKey}`, id);
  const projects = useProjects(id);
  const changed = () => {
    detail.reload();
    phases.reload();
    projects.reload();
  };
  const d = detail.data;
  const live = useMemo(
    () => (d ? mergeLive(d.live, board as Record<string, AtlasSession>, id) : []),
    [d, board, id],
  );
  const archived = useMemo(() => (d?.archived ?? []).slice(0, ARCHIVED_CAP), [d]);
  const notFound = detail.error !== null && d === null;
  const name = d?.project.name || d?.project.project_dir || "n/a";
  const color = d?.project.color ?? "";
  const colorCss = cssColor(color);

  if (notFound) {
    return (
      <section className="mx-auto flex max-w-5xl flex-col gap-s-3 p-s-4">
        <p role="alert" className="m-0 text-state-error">
          <span aria-hidden="true">✖ </span>
          {detail.error}
        </p>
        <Link to="/projects" className="text-accent underline">
          Back to Projects
        </Link>
      </section>
    );
  }

  return (
    <article
      aria-label={`Project ${name}`}
      data-testid="project-view"
      data-project-id={id}
      data-color={colorCss ?? undefined}
      className="mx-auto flex max-w-6xl flex-col gap-s-6 p-s-4"
    >
      <header className="flex flex-col gap-s-2">
        <Link to="/projects" className="w-fit text-sm text-accent underline">
          ← Projects
        </Link>
        <div className="flex items-center gap-s-3">
          <h1 className="m-0 min-w-0 text-xl font-normal" data-testid="project-name">
            {d ? (
              <InlineEdit
                value={d.project.name}
                label={`Project name: ${name}`}
                hint="Enter saves, Escape cancels"
                maxLength={80}
                required
                className="w-96 max-w-full"
                onSave={async (text) => {
                  await atlasApi.patchProject(id, { name: text });
                  changed();
                }}
              >
                <span className="truncate">{name}</span>
              </InlineEdit>
            ) : (
              <span className="text-fg-muted">n/a</span>
            )}
          </h1>
        </div>
        {d ? (
          <ColorPicker
            color={color}
            onPick={async (c) => {
              await atlasApi.patchProject(id, { color: c });
              changed();
            }}
          />
        ) : null}
        <p className="num m-0 truncate text-xs text-fg-muted" title={d?.project.project_dir}>
          {d?.project.project_dir ?? "n/a"}
        </p>
        <p role="status" className="m-0 min-h-[1em] text-xs text-state-error">
          {detail.error && d ? `✖ ${detail.error}` : ""}
        </p>
      </header>

      <Section id="totals" title="Totals">
        <dl className="m-0 grid grid-cols-3 gap-s-3" data-testid="totals">
          {[
            ["Sessions", formatCount(d?.totals.sessions), "sessions"],
            ["Hours", formatHours(d?.totals.hours), "hours"],
            ["Cost", formatTotalCost(d?.totals.cost_usd), "cost"],
          ].map(([label, value, key]) => (
            <div key={key} className="rounded-lg border border-border bg-surface-1 px-s-3 py-s-2">
              <dt className="text-xs uppercase tracking-wide text-fg-muted">{label}</dt>
              <dd className="num m-0 text-lg" data-slot={key}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="branches" title="Active branches" count={d ? String(d.branches.length) : "n/a"}>
        {d && d.branches.length === 0 ? (
          <Empty>No active branches.</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-wrap gap-s-2 p-0" data-testid="branches">
            {(d?.branches ?? []).map((b) => (
              <li
                key={b.branch}
                data-branch={b.branch}
                className="num rounded border border-border bg-surface-1 px-s-2 py-s-1 text-sm"
              >
                {b.branch} <span className="text-fg-muted">×{b.sessions}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="live" title="Live sessions" count={d ? String(live.length) : "n/a"}>
        {d && live.length === 0 ? (
          <Empty>No live sessions in this project.</Empty>
        ) : (
          <div className="rounded-lg border border-border bg-surface-1">
            <RowHead />
            <FixedList
              label="Live sessions"
              testId="live-list"
              items={live}
              rowHeight={ROW_H}
              itemKey={(s) => s.session_id}
              render={(s) => <SessionRow s={s} live projects={projects.data} onChanged={changed} />}
            />
          </div>
        )}
      </Section>

      <Section
        id="archived"
        title={`Last ${ARCHIVED_CAP} archived`}
        count={d ? String(archived.length) : "n/a"}
      >
        {d && archived.length === 0 ? (
          <Empty>No archived sessions yet.</Empty>
        ) : (
          <div className="rounded-lg border border-border bg-surface-1">
            <RowHead />
            <FixedList
              label="Archived sessions"
              testId="archived-list"
              items={archived}
              rowHeight={ROW_H}
              itemKey={(s) => s.session_id}
              render={(s) => (
                <SessionRow s={s} live={false} projects={projects.data} onChanged={changed} />
              )}
            />
          </div>
        )}
      </Section>

      <Section id="phases" title="Phases" count={phases.data ? String(phases.data.length) : "n/a"}>
        {phases.data && phases.data.length === 0 ? (
          <Empty>No phases yet. Name a session P3 or set a label on a row above.</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-wrap gap-s-2 p-0" data-testid="phases">
            {(phases.data ?? []).map((p) => (
              <li
                key={p.phase}
                data-phase={p.phase}
                className="num rounded border border-border bg-surface-1 px-s-2 py-s-1 text-sm"
              >
                {p.phase} <span className="text-fg-muted">×{p.sessions}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </article>
  );
}
