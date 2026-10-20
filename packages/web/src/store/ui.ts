import { create } from "zustand";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";

export type Theme = "dark" | "light";

export interface Settings {
  hubUrl: string;
  token: string;
  notifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = { hubUrl: "", token: "", notifications: false };

export function loadSettings(): Settings {
  const raw = readStored(STORAGE_KEYS.settings);
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      hubUrl: typeof p.hubUrl === "string" ? p.hubUrl : "",
      token: typeof p.token === "string" ? p.token : "",
      notifications: p.notifications === true,
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
  toggleTheme: () => void;
  toggleCompact: () => void;
  saveSettings: (s: Settings) => void;
}

export const useUi = create<UiState>()((set, get) => ({
  theme: readStored(STORAGE_KEYS.theme) === "light" ? "light" : "dark",
  compact: readStored(STORAGE_KEYS.compact) === "1",
  settings: loadSettings(),
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
