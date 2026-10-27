import { useCallback, useEffect, useRef, useState } from "react";
import { atlasApi } from "./api";
import type { ProjectSummary } from "./types";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever `key` changes (data is kept across key changes within one `scope`, dropped when `scope` changes) or `reload()` is called; ignores stale results. */
export function useLoad<T>(load: () => Promise<T>, key: string, scope: string = key): Loaded<T> {
  const [state, setState] = useState<{
    scope: string;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ scope, data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    // A new scope is a different resource: drop the previous one's data and error.
    setState((s) =>
      s.scope === scope
        ? { ...s, loading: true }
        : { scope, data: null, error: null, loading: true },
    );
    loadRef.current().then(
      (data) => alive && setState({ scope, data, error: null, loading: false }),
      (e: unknown) =>
        alive &&
        setState((s) => ({
          scope,
          data: s.scope === scope ? s.data : null,
          error: e instanceof Error ? e.message : "Failed to load",
          loading: false,
        })),
    );
    return () => {
      alive = false;
    };
  }, [key, scope, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Until the effect for a new scope has run, the old scope's state must not leak into this render.
  if (state.scope !== scope) return { data: null, error: null, loading: true, reload };
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/** All projects, for the list and for the "Move to project" selects. */
export function useProjects(key = ""): Loaded<ProjectSummary[]> {
  return useLoad(() => atlasApi.listProjects(), `projects:${key}`);
}
