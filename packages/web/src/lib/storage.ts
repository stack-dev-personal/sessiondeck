/** Per-viewer conveniences only (theme, compact, settings). Every access is guarded. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable or full: the preference simply does not persist */
  }
}

export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export const STORAGE_KEYS = {
  theme: "sd.theme",
  compact: "sd.compact",
  settings: "sd.settings",
  filters: "sd.filters",
  layout: "sd.layout",
  /** The spec as it was before Shift+C compacted everything (R6.5). */
  layoutSnapshot: "sd.layout.snapshot",
  /** Last saved-layouts list received from the hub (R6.3), so a switch never waits on the network. */
  savedLayouts: "sd.layouts.saved",
} as const;
