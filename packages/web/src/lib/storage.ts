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

export const STORAGE_KEYS = {
  theme: "sd.theme",
  compact: "sd.compact",
  settings: "sd.settings",
} as const;
