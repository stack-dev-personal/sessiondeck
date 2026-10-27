import { create } from "zustand";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import { setPaneCompact, setRatiosAt } from "../layout/ops";
import { buildPreset, type PresetName } from "../layout/presets";
import { parse, serialize, type LayoutSpec } from "../layout/spec";

/** The layout a fresh viewer gets, and the fallback when the stored one is corrupt. */
export const DEFAULT_PRESET: PresetName = "solo";

export function loadLayout(): LayoutSpec {
  const raw = readStored(STORAGE_KEYS.layout);
  if (raw !== null) {
    const r = parse(raw);
    if (r.ok) return r.spec;
  }
  return buildPreset(DEFAULT_PRESET);
}

export interface LayoutState {
  spec: LayoutSpec;
  /** Replaces the whole spec (a preset, a saved layout later). */
  setSpec: (spec: LayoutSpec) => void;
  applyPreset: (name: PresetName, projects?: readonly string[]) => void;
  setRatios: (path: readonly number[], ratios: number[]) => void;
  setPaneCompact: (paneId: string, compact: boolean) => void;
}

/**
 * Every action is `spec -> spec` through layout/ops.ts, then persisted. Later units add
 * snapshot/restore (R6.5), assignment (R6.6) and saved layouts (R6.3) as more reducers.
 * Persisted per viewer in localStorage until the hub stores layouts (R6.3).
 */
export const useLayout = create<LayoutState>()((set, get) => {
  const commit = (spec: LayoutSpec) => {
    if (spec === get().spec) return;
    writeStored(STORAGE_KEYS.layout, serialize(spec));
    set({ spec });
  };
  return {
    spec: loadLayout(),
    setSpec: commit,
    applyPreset: (name, projects = []) => commit(buildPreset(name, projects)),
    setRatios: (path, ratios) => commit(setRatiosAt(get().spec, path, ratios)),
    setPaneCompact: (id, compact) => commit(setPaneCompact(get().spec, id, compact)),
  };
});
