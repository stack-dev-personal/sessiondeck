import { create } from "zustand";
import { NO_FILTERS, type Filters } from "../lib/attention";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";

export function loadFilters(): Filters {
  const raw = readStored(STORAGE_KEYS.filters);
  if (raw === null) return NO_FILTERS;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof Filters, unknown>>;
    const pick = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    return { host: pick(p.host), project: pick(p.project) };
  } catch {
    return NO_FILTERS;
  }
}

export interface FilterState extends Filters {
  setHost: (host: string | null) => void;
  setProject: (project: string | null) => void;
  clear: () => void;
}

/** Board filters: a per-viewer convenience, so they persist in localStorage (guarded), not the URL. */
export const useFilters = create<FilterState>()((set, get) => {
  const save = (f: Filters) => writeStored(STORAGE_KEYS.filters, JSON.stringify(f));
  return {
    ...loadFilters(),
    setHost: (host) => {
      save({ host, project: get().project });
      set({ host });
    },
    setProject: (project) => {
      save({ host: get().host, project });
      set({ project });
    },
    clear: () => {
      save(NO_FILTERS);
      set(NO_FILTERS);
    },
  };
});
