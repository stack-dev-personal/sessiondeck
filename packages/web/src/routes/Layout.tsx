import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LayoutMenu } from "../components/layout/LayoutMenu";
import { LayoutView } from "../components/layout/LayoutView";
import { isPresetName, type PresetName } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { LAYOUT_KEYS, useShortcuts } from "../lib/keys";
import { selectProjects } from "../lib/attention";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";

/**
 * Layout mode. `?preset=<name>` applies a builtin once and is then removed from the URL, so a
 * reload shows the persisted layout, not the query. by-project waits for the first projects.
 */
export function Layout() {
  const spec = useLayout((s) => s.spec);
  const applyPreset = useLayout((s) => s.applyPreset);
  const sessions = useBoard((s) => s.sessions);
  const projects = useMemo(() => selectProjects(sessions), [sessions]);
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const wanted = params.get("preset");

  useEffect(() => {
    if (wanted === null) return;
    if (!isPresetName(wanted)) {
      setParams((p) => (p.delete("preset"), p), { replace: true });
      return;
    }
    if (wanted === "by-project" && projects.length === 0) return;
    applyPreset(wanted, projects);
    setParams((p) => (p.delete("preset"), p), { replace: true });
  }, [wanted, projects, applyPreset, setParams]);

  const keys = useMemo(() => ({ [LAYOUT_KEYS.menu]: () => setOpen((o) => !o) }), []);
  useShortcuts(keys);
  const pick = (name: PresetName) => applyPreset(name, projects);

  return (
    <div className="flex h-full flex-col" data-testid="layout-route">
      <h1 className="sr-only">Layout</h1>
      <div className="flex shrink-0 items-center gap-s-3 border-b border-border px-s-4 py-s-2">
        <LayoutMenu current={spec.id} open={open} onOpenChange={setOpen} onPick={pick} />
        <span className="num text-sm text-fg-muted" data-testid="pane-count">
          {panesOf(spec).length} {panesOf(spec).length === 1 ? "pane" : "panes"}
        </span>
      </div>
      <div className="min-h-0 flex-1 bg-border">
        <LayoutView spec={spec} />
      </div>
    </div>
  );
}
