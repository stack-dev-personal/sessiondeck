import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LayoutMenu } from "../components/layout/LayoutMenu";
import { LayoutView } from "../components/layout/LayoutView";
import { ManageDialog, SaveDialog } from "../components/layout/SavedDialogs";
import {
  AUTOFIT_MAX_SESSIONS,
  autoFit,
  autoFitMore,
  isLive,
  type AutoFitMode,
} from "../layout/autofit";
import { isPresetName, MAX_PROJECT_COLUMNS, type PresetName } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { LAYOUT_KEYS, useShortcuts } from "../lib/keys";
import { projectDirOf, projectDirsByAttention } from "../lib/attention";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";
import { useSaved } from "../store/saved";
import { useUi } from "../store/ui";

/**
 * Layout mode. `?preset=<name>` applies a builtin once and is then removed from the URL, so a
 * reload shows the persisted layout, not the query. by-project waits for the first full set of
 * sessions (replay done or hub resync) and then applies even when there are none: one unassigned pane.
 */
export function Layout() {
  const spec = useLayout((s) => s.spec);
  const applyPreset = useLayout((s) => s.applyPreset);
  const loaded = useBoard((s) => s.loaded);
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const wanted = params.get("preset");
  const waiting = wanted === "by-project" && !loaded;

  // Read at apply time, not subscribed: the project order changes on most deltas (R6.4).
  useEffect(() => {
    if (wanted === null) return;
    if (!isPresetName(wanted)) {
      setParams((p) => (p.delete("preset"), p), { replace: true });
      return;
    }
    if (waiting) return;
    applyPreset(wanted, projectDirsByAttention(useBoard.getState().sessions));
    setParams((p) => (p.delete("preset"), p), { replace: true });
  }, [wanted, waiting, loaded, applyPreset, setParams]);

  const arrange = useCallback((mode: AutoFitMode) => {
    const all = Object.values(useBoard.getState().sessions);
    const next = autoFit(all, mode);
    useLayout.getState().applyAutoFit(next);
    const n = all.filter(isLive).length;
    useSaved
      .getState()
      .say(
        "info",
        mode === "project"
          ? `Split ${n} live ${n === 1 ? "session" : "sessions"} by project.`
          : `Arranged ${n} live ${n === 1 ? "session" : "sessions"}: ${next.name}.`,
      );
  }, []);
  const [dialog, setDialog] = useState<"save" | "manage" | null>(null);
  // The explicit Viewer host setting (Settings); null means only unpinned layouts resolve.
  const host = useUi((s) => s.settings.viewerHost);
  const toggleCompactAll = useLayout((s) => s.toggleCompactAll);
  const compacted = useLayout((s) => s.snapshot !== null);
  const press = useSaved((s) => s.press);
  const savedCount = useSaved((s) => s.rows.length);
  const savedStatus = useSaved((s) => s.status);
  // A saved layout is shown by its name (the live row, so a rename shows), never by its id.
  const savedName = useSaved((s) => s.rows.find((r) => r.id === spec.id)?.name);
  const currentName = savedName ?? spec.name;
  // The host is read at key time so a hotkey never closes over a stale setting.
  const hostRef = useRef(host);
  hostRef.current = host;
  const keys = useMemo(() => {
    if (dialog !== null) return {};
    const map: Record<string, () => void> = {
      [LAYOUT_KEYS.menu]: () => setOpen((o) => !o),
      [LAYOUT_KEYS.save]: () => setDialog("save"),
      [LAYOUT_KEYS.manage]: () => setDialog("manage"),
      [LAYOUT_KEYS.compactAll]: toggleCompactAll,
      [LAYOUT_KEYS.arrange]: () => arrange("count"),
      [LAYOUT_KEYS.byProject]: () => arrange("project"),
    };
    for (const k of LAYOUT_KEYS.slots) map[k] = () => void press(Number(k), hostRef.current);
    return map;
  }, [dialog, toggleCompactAll, press, arrange]);
  useShortcuts(keys);
  // Notices newer than this route's mount (an old load error is shown by the status chip instead).
  const noticeAtMount = useRef(useSaved.getState().notice?.n ?? 0);
  const notice = useSaved((s) =>
    s.notice && s.notice.n > noticeAtMount.current ? s.notice : null,
  );
  // Count the projects that have no column, not a difference of totals: the session set can change
  // after the preset was applied, so a column may point at a project that is gone.
  const shownDirs = useMemo(() => {
    const set = new Set<string>();
    for (const p of panesOf(spec)) if (p.projectDir !== undefined) set.add(p.projectDir);
    return set;
  }, [spec]);
  // Only projects with a live session are advertised, the same set "p" would give a column.
  // A number, so a delta that moves no project in or out of view does not re-render the layout.
  const byProject = spec.id === "by-project";
  const hidden = useBoard((s) => {
    if (!byProject) return 0;
    const dirs = new Set<string>();
    for (const v of Object.values(s.sessions)) if (isLive(v)) dirs.add(projectDirOf(v));
    let n = 0;
    for (const d of dirs) if (!shownDirs.has(d)) n++;
    return n;
  });
  // Only when the six panes were filled (by Arrange); a grid6 picked from the menu says nothing.
  const sessionPanes = panesOf(spec).filter((p) => p.type === "session");
  const filled = spec.id === "grid6" && sessionPanes.every((p) => p.sessionId !== undefined);
  const moreLive = useBoard((s) => (filled ? autoFitMore(Object.values(s.sessions)) : 0));
  const pick = (name: PresetName) =>
    applyPreset(name, projectDirsByAttention(useBoard.getState().sessions));

  return (
    <div className="flex h-full flex-col" data-testid="layout-route">
      <h1 className="sr-only">Layout</h1>
      <div className="flex shrink-0 items-center gap-s-3 border-b border-border px-s-4 py-s-2">
        <LayoutMenu
          current={spec.id}
          currentName={currentName}
          open={open}
          onOpenChange={setOpen}
          onPick={pick}
        />
        <span className="num w-[5rem] shrink-0 text-sm text-fg-muted" data-testid="pane-count">
          {panesOf(spec).length} {panesOf(spec).length === 1 ? "pane" : "panes"}
        </span>
        <button
          type="button"
          className="num w-[14rem] shrink-0 whitespace-nowrap rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-left text-sm text-fg hover:bg-surface-3"
          aria-pressed={compacted}
          onClick={toggleCompactAll}
          title={compacted ? "Compact all is on: press to restore the panes" : undefined}
          data-testid="compact-all"
        >
          <span aria-hidden="true" className="inline-block w-[1.5em]">
            {compacted ? "◼" : "◻"}
          </span>
          Compact all (Shift+C)
        </button>
        <button
          type="button"
          className="num shrink-0 whitespace-nowrap rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-sm text-fg hover:bg-surface-3"
          onClick={() => arrange("count")}
          title="Pick the preset for the number of live sessions and place the most urgent ones"
          data-testid="arrange"
        >
          Arrange (a)
        </button>
        <button
          type="button"
          className="num shrink-0 whitespace-nowrap rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-sm text-fg hover:bg-surface-3"
          onClick={() => arrange("project")}
          title="One column per project with a live session"
          data-testid="split-by-project"
        >
          By project (p)
        </button>
        <button
          type="button"
          className="num shrink-0 whitespace-nowrap rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-sm text-fg hover:bg-surface-3"
          onClick={() => setDialog("save")}
        >
          Save (s)
        </button>
        <button
          type="button"
          className="num w-[13rem] shrink-0 overflow-hidden whitespace-nowrap rounded border border-border-control bg-surface-2 px-s-3 py-s-1 text-left text-sm text-fg hover:bg-surface-3"
          onClick={() => setDialog("manage")}
        >
          Saved: {savedCount}
          {savedStatus === "offline" ? " (cached)" : ""} (m)
        </button>
        {spec.id === "by-project" && hidden > 0 ? (
          <span className="num text-sm text-fg-muted" data-testid="projects-more">
            {`+${hidden} more ${hidden === 1 ? "project" : "projects"} (most urgent ${MAX_PROJECT_COLUMNS} shown)`}
          </span>
        ) : null}
        {moreLive > 0 ? (
          <span className="num text-sm text-fg-muted" data-testid="sessions-more">
            {`+${moreLive} more live ${moreLive === 1 ? "session" : "sessions"} (most urgent ${AUTOFIT_MAX_SESSIONS} shown)`}
          </span>
        ) : null}
        {waiting ? (
          <span className="num text-sm text-fg-muted" role="status" data-testid="layout-waiting">
            Waiting for projects
          </span>
        ) : null}
        <output
          className={`num ml-auto min-w-[16rem] max-w-[32rem] truncate text-sm ${notice?.tone === "error" ? "text-state-error" : "text-fg-muted"}`}
          data-testid="layout-notice"
          role="status"
        >
          {notice ? `${notice.tone === "error" ? "✖" : "ℹ"} ${notice.text}` : ""}
        </output>
      </div>
      <div className="min-h-0 flex-1 bg-border">
        <LayoutView spec={spec} />
      </div>
      {dialog === "save" ? <SaveDialog host={host} onClose={() => setDialog(null)} /> : null}
      {dialog === "manage" ? <ManageDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
