import { useCallback, useEffect, useRef, useState } from "react";
import { atlasApi } from "./api";
import type { ProjectSummary } from "./types";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever `key` changes or `reload()` is called; ignores stale results. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) =>
        alive &&
        setState((s) => ({
          data: s.data,
          error: e instanceof Error ? e.message : "Failed to load",
          loading: false,
        })),
    );
    return () => {
      alive = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** All projects, for the list and for the "Move to project" selects. */
export function useProjects(key = ""): Loaded<ProjectSummary[]> {
  return useLoad(() => atlasApi.listProjects(), `projects:${key}`);
}
