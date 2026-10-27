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
  /**
   * The host this browser is "on", for saved-layout hotkeys and pinning. null (default): only
   * layouts not pinned to a host resolve. Never inferred from activity, so a key always does the
   * same thing.
   */
  viewerHost: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  hubUrl: "",
  token: "",
  notifications: false,
  sounds: { waiting_permission: false, waiting_input: false },
  muted: false,
  viewerHost: null,
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
      viewerHost:
        typeof p.viewerHost === "string" && p.viewerHost.length > 0 && p.viewerHost.length <= 128
          ? p.viewerHost
          : null,
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
  /** True while a modal dialog (save, manage) is mounted; global shortcuts stay quiet. Not persisted. */
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;
  openSession: (id: string) => void;
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
  modalOpen: false,
  setModalOpen: (modalOpen) => set({ modalOpen }),
  openSession: (id) => set({ selectedSessionId: id }),
  closeSession: () => set({ selectedSessionId: null }),
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
