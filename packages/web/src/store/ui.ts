import type { SessionSnapshot } from "@sessiondeck/contract";
import { create } from "zustand";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";

export type Theme = "dark" | "light";

export interface Settings {
  hubUrl: string;
  token: string;
  notifications: boolean;
  /** Short tone per attention state, each opt-in. */
  sounds: { waiting_permission: boolean; waiting_input: boolean };
  /** One global mute that silences every tone without losing the per-state choices. */
  muted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  hubUrl: "",
  token: "",
  notifications: false,
  sounds: { waiting_permission: false, waiting_input: false },
  muted: false,
};

export function loadSettings(): Settings {
  const raw = readStored(STORAGE_KEYS.settings);
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const p = JSON.parse(raw) as Partial<Settings>;
    const snd = (typeof p.sounds === "object" && p.sounds !== null ? p.sounds : {}) as Partial<
      Settings["sounds"]
    >;
    return {
      hubUrl: typeof p.hubUrl === "string" ? p.hubUrl : "",
      token: typeof p.token === "string" ? p.token : "",
      notifications: p.notifications === true,
      sounds: {
        waiting_permission: snd.waiting_permission === true,
        waiting_input: snd.waiting_input === true,
      },
      muted: p.muted === true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export interface UiState {
  theme: Theme;
  compact: boolean;
  settings: Settings;
  /** Session whose detail drawer is open; null when closed. Not persisted. */
  selectedSessionId: string | null;
  /** Snapshot for a session the board does not hold (ended long ago, from GET /sessions). */
  fallbackSession: SessionSnapshot | null;
  /** Command palette (Ctrl+K) is open. Board and list keys are off while it is. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  openSession: (id: string, fallback?: SessionSnapshot) => void;
  closeSession: () => void;
  toggleTheme: () => void;
  toggleCompact: () => void;
  saveSettings: (s: Settings) => void;
}

export const useUi = create<UiState>()((set, get) => ({
  theme: readStored(STORAGE_KEYS.theme) === "light" ? "light" : "dark",
  compact: readStored(STORAGE_KEYS.compact) === "1",
  settings: loadSettings(),
  selectedSessionId: null,
  fallbackSession: null,
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openSession: (id, fallback) => set({ selectedSessionId: id, fallbackSession: fallback ?? null }),
  closeSession: () => set({ selectedSessionId: null, fallbackSession: null }),
  toggleTheme: () => {
    const theme: Theme = get().theme === "dark" ? "light" : "dark";
    writeStored(STORAGE_KEYS.theme, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleCompact: () => {
    const compact = !get().compact;
    writeStored(STORAGE_KEYS.compact, compact ? "1" : "0");
    set({ compact });
  },
  saveSettings: (settings) => {
    writeStored(STORAGE_KEYS.settings, JSON.stringify(settings));
    set({ settings });
  },
}));
