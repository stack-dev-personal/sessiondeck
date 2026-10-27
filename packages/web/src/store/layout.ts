import { create } from "zustand";
import { readStored, removeStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import {
  assignSession,
  compactAll,
  dedupeSessions,
  setPaneCompact,
  setRatiosAt,
  unassignPane,
} from "../layout/ops";
import { buildPreset, type PresetName } from "../layout/presets";
import { parse, serialize, validate, type LayoutSpec } from "../layout/spec";

/** The layout a fresh viewer gets, and the fallback when the stored one is corrupt. */
export const DEFAULT_PRESET: PresetName = "solo";

export function loadLayout(): LayoutSpec {
  const raw = readStored(STORAGE_KEYS.layout);
  if (raw !== null) {
    const r = parse(raw);
    if (r.ok) return dedupeSessions(r.spec);
  }
  return buildPreset(DEFAULT_PRESET);
}

/** The pre-compact snapshot, only when it still belongs to the stored layout (same id). */
function loadSnapshot(current: LayoutSpec): LayoutSpec | null {
  const raw = readStored(STORAGE_KEYS.layoutSnapshot);
  if (raw === null) return null;
  const r = parse(raw);
  return r.ok && r.spec.id === current.id ? dedupeSessions(r.spec) : null;
}

export interface LayoutState {
  spec: LayoutSpec;
  /**
   * Compact-all state (R6.5). Non-null means "everything was compacted by Shift+C" and holds the
   * spec exactly as it was before (every ratio, every pane's own compact flag, assignments).
   * Rules, kept in this one place:
   *  - toggleCompactAll() while null: snapshot the spec, then compact every pane.
   *  - toggleCompactAll() while set: the spec becomes the snapshot, exactly; the snapshot clears.
   *    Anything done while compacted (a resize, expanding one pane by hand) is discarded by the
   *    restore, because the contract is "restores the previous layout exactly".
   *  - setRatios and setPaneCompact (manual edits) keep the snapshot.
   *  - setSpec and applyPreset (switching to another layout, saved or builtin) drop it: the old
   *    layout is gone, so there is nothing to restore into.
   *  - The snapshot is persisted with the layout and ignored on load when its id differs.
   */
  snapshot: LayoutSpec | null;
  /** Replaces the whole spec (a saved layout) and drops any compact-all snapshot. */
  setSpec: (spec: LayoutSpec) => void;
  applyPreset: (name: PresetName, projects?: readonly string[]) => void;
  setRatios: (path: readonly number[], ratios: number[]) => void;
  setPaneCompact: (paneId: string, compact: boolean) => void;
  /**
   * Pane assignment (R6.6). While compact-all is on the same change is applied to the snapshot, so
   * an assignment made then survives the restore (assignments are not part of "compact").
   */
  assign: (paneId: string, sessionId: string) => void;
  unassign: (paneId: string) => void;
  /** Replaces the layout with an auto-fit result (R6.2); like applyPreset it drops the snapshot. */
  applyAutoFit: (spec: LayoutSpec) => void;
  /** Shift+C. */
  toggleCompactAll: () => void;
}

/**
 * Every action is `spec -> spec` through layout/ops.ts, then persisted. Later units add
 * assignment (R6.6) as more reducers. Persisted per viewer in localStorage; saved layouts live in
 * the hub (store/saved.ts) and arrive here through setSpec.
 */
export const useLayout = create<LayoutState>()((set, get) => {
  const persist = (spec: LayoutSpec, snapshot: LayoutSpec | null) => {
    writeStored(STORAGE_KEYS.layout, serialize(spec));
    if (snapshot) writeStored(STORAGE_KEYS.layoutSnapshot, serialize(snapshot));
    else removeStored(STORAGE_KEYS.layoutSnapshot);
  };
  /** Never persist or show a spec that parse() would reject on the next load. */
  const commit = (rawSpec: LayoutSpec, rawSnapshot: LayoutSpec | null = get().snapshot) => {
    // The one choke point: every spec (saved layout, press, restore, edit) and the stored snapshot
    // pass through here, so no source can put one session in two panes (R6.6).
    const spec = dedupeSessions(rawSpec);
    const snapshot = rawSnapshot && dedupeSessions(rawSnapshot);
    if (spec === get().spec && snapshot === get().snapshot) return;
    if (!validate(spec).ok) return;
    persist(spec, snapshot);
    set({ spec, snapshot });
  };
  const initial = loadLayout();
  return {
    spec: initial,
    snapshot: loadSnapshot(initial),
    setSpec: (spec) => commit(spec, null),
    applyPreset: (name, projects = []) => commit(buildPreset(name, projects), null),
    // The library reports percentages that can drift from an exact sum; rescale before validating.
    setRatios: (path, ratios) => {
      const sum = ratios.reduce((a, b) => a + b, 0);
      if (!(sum > 0)) return;
      commit(
        setRatiosAt(
          get().spec,
          path,
          ratios.map((r) => r / sum),
        ),
      );
    },
    setPaneCompact: (id, compact) => commit(setPaneCompact(get().spec, id, compact)),
    assign: (paneId, sessionId) => {
      const { spec, snapshot } = get();
      commit(
        assignSession(spec, paneId, sessionId),
        snapshot && assignSession(snapshot, paneId, sessionId),
      );
    },
    unassign: (paneId) => {
      const { spec, snapshot } = get();
      commit(unassignPane(spec, paneId), snapshot && unassignPane(snapshot, paneId));
    },
    applyAutoFit: (spec) => commit(spec, null),
    toggleCompactAll: () => {
      const { spec, snapshot } = get();
      if (snapshot) commit(snapshot, null);
      else commit(compactAll(spec), spec);
    },
  };
});
