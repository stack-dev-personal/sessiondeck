import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LayoutMenu } from "../components/layout/LayoutMenu";
import { LayoutView } from "../components/layout/LayoutView";
import { isPresetName, MAX_PROJECT_COLUMNS, type PresetName } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { LAYOUT_KEYS, useShortcuts } from "../lib/keys";
import { projectDirsByAttention } from "../lib/attention";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";

/**
 * Layout mode. `?preset=<name>` applies a builtin once and is then removed from the URL, so a
 * reload shows the persisted layout, not the query. by-project waits for the first full set of
 * sessions (replay done or hub resync) and then applies even when there are none: one unassigned pane.
 */
export function Layout() {
  const spec = useLayout((s) => s.spec);
  const applyPreset = useLayout((s) => s.applyPreset);
  const sessions = useBoard((s) => s.sessions);
  const loaded = useBoard((s) => s.loaded);
  const projects = useMemo(() => projectDirsByAttention(sessions), [sessions]);
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const wanted = params.get("preset");
  const waiting = wanted === "by-project" && !loaded;

  useEffect(() => {
    if (wanted === null) return;
    if (!isPresetName(wanted)) {
      setParams((p) => (p.delete("preset"), p), { replace: true });
      return;
    }
    if (waiting) return;
    applyPreset(wanted, projects);
    setParams((p) => (p.delete("preset"), p), { replace: true });
  }, [wanted, waiting, projects, applyPreset, setParams]);

  const keys = useMemo(() => ({ [LAYOUT_KEYS.menu]: () => setOpen((o) => !o) }), []);
  useShortcuts(keys);
  // Count the projects that have no column, not a difference of totals: the session set can change
  // after the preset was applied, so a column may point at a project that is gone.
  const shownDirs = new Set<string>();
  for (const p of panesOf(spec)) if (p.projectDir !== undefined) shownDirs.add(p.projectDir);
  const hidden = projects.filter((d) => !shownDirs.has(d)).length;
  const pick = (name: PresetName) => applyPreset(name, projects);

  return (
    <div className="flex h-full flex-col" data-testid="layout-route">
      <h1 className="sr-only">Layout</h1>
      <div className="flex shrink-0 items-center gap-s-3 border-b border-border px-s-4 py-s-2">
        <LayoutMenu current={spec.id} open={open} onOpenChange={setOpen} onPick={pick} />
        <span className="num text-sm text-fg-muted" data-testid="pane-count">
          {panesOf(spec).length} {panesOf(spec).length === 1 ? "pane" : "panes"}
        </span>
        {spec.id === "by-project" && hidden > 0 ? (
          <span className="num text-sm text-fg-muted" data-testid="projects-more">
            {`+${hidden} more ${hidden === 1 ? "project" : "projects"} (most urgent ${MAX_PROJECT_COLUMNS} shown)`}
          </span>
        ) : null}
        {waiting ? (
          <span className="num text-sm text-fg-muted" role="status" data-testid="layout-waiting">
            Waiting for projects
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 bg-border">
        <LayoutView spec={spec} />
      </div>
    </div>
  );
}
