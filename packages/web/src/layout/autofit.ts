/**
 * Auto-fit (R6.2): pick the preset for the number of live sessions and put the most urgent
 * sessions in the panes. Pure: the same sessions give the same spec.
 *
 * Count table (live sessions = state is not ended or exited):
 *   0 strip (board only)      1 solo      2 pair      3 focus (3 of its 4 session panes used)
 *   4 quad                    5 grid6 (one pane unassigned)      6 grid6      >6 grid6 with the six
 *                                                              most urgent; autoFitMore() counts the rest
 * Sessions are assigned in attention order (waiting first, then newest event) to the preset's
 * session panes in reading order, so the most urgent session gets the first (largest) pane.
 * Focus with three: the 70% pane, then the two top small panes; the fourth stays unassigned
 * rather than showing a repeated or ended session.
 * "project" mode makes a by-project layout with a column per project that has a live session.
 */
import type { SessionSnapshot } from "@sessiondeck/contract";
import { projectDirsByAttention, sortForAttention } from "../lib/attention";
import { buildPreset, type PresetName } from "./presets";
import { panesOf, type LayoutSpec } from "./spec";

export type AutoFitMode = "count" | "project";

export const AUTOFIT_MAX_SESSIONS = 6;

export const isLive = (s: SessionSnapshot): boolean => s.state !== "ended" && s.state !== "exited";

/** The preset for a live count. */
export function presetForCount(n: number): PresetName {
  if (n <= 0) return "strip";
  if (n === 1) return "solo";
  if (n === 2) return "pair";
  if (n === 3) return "focus";
  if (n === 4) return "quad";
  return "grid6";
}

/** Live sessions that auto-fit by count has no pane for. */
export function autoFitMore(sessions: readonly SessionSnapshot[]): number {
  return Math.max(0, sessions.filter(isLive).length - AUTOFIT_MAX_SESSIONS);
}

export function autoFit(sessions: readonly SessionSnapshot[], mode: AutoFitMode): LayoutSpec {
  const live = sortForAttention(sessions.filter(isLive));
  if (mode === "project") {
    return buildPreset(
      "by-project",
      projectDirsByAttention(Object.fromEntries(live.map((s) => [s.session_id, s]))),
    );
  }
  const spec = buildPreset(presetForCount(live.length));
  const ids = live.slice(0, AUTOFIT_MAX_SESSIONS).map((s) => s.session_id);
  const targets = panesOf(spec).filter((p) => p.type === "session");
  const byPane = new Map(targets.map((p, i) => [p.id, ids[i]]));
  const assign = (n: LayoutSpec["root"]): LayoutSpec["root"] => {
    if (n.kind === "split") return { ...n, children: n.children.map(assign) };
    const id = byPane.get(n.id);
    return id === undefined ? n : { ...n, sessionId: id };
  };
  return { ...spec, root: assign(spec.root) };
}
