import type { SessionSnapshot, SessionState } from "@sessiondeck/contract";
import { basename } from "./format";

/** The two states that wait on the user. They pin to the top of the board. */
export function isAttentionState(state: SessionState): boolean {
  return state === "waiting_permission" || state === "waiting_input";
}

/**
 * Project name shown on the card and used by the project filter: the hub's project name (worktrees
 * roll up to the repo, manual reassignment wins), else project_dir, else cwd, else id.
 */
export function projectOf(s: SessionSnapshot): string {
  const named = (s as { project_name?: unknown }).project_name;
  if (typeof named === "string" && named !== "") return named;
  return basename(s.project_dir) ?? basename(s.cwd) ?? s.session_id;
}

/** Pane value for sessions that report neither project_dir nor cwd. */
export const NO_PROJECT_DIR = "(no project)";

/** Full project directory used to match project panes: project_dir, else cwd, else NO_PROJECT_DIR. */
export function projectDirOf(s: SessionSnapshot): string {
  return s.project_dir || s.cwd || NO_PROJECT_DIR;
}

/**
 * Distinct full project dirs, most urgent first: a project ranks by its best session in
 * sortForAttention order (waiting sessions first, then newest event).
 */
export function projectDirsByAttention(sessions: Record<string, SessionSnapshot>): string[] {
  return [...new Set(sortForAttention(Object.values(sessions)).map(projectDirOf))];
}

const segments = (p: string): string[] => p.split(/[\\/]/).filter(Boolean);

/**
 * Display label per full dir: the basename, or "parent/basename" when two dirs share a basename.
 */
export function projectLabels(dirs: readonly string[]): Map<string, string> {
  const base = (d: string) => segments(d).at(-1) ?? d;
  const count = new Map<string, number>();
  for (const d of dirs) count.set(base(d), (count.get(base(d)) ?? 0) + 1);
  return new Map(
    dirs.map((d) => {
      const seg = segments(d);
      const label =
        d === NO_PROJECT_DIR
          ? d
          : (count.get(base(d)) ?? 0) > 1 && seg.length > 1
            ? `${seg.at(-2)}/${base(d)}`
            : base(d);
      return [d, label];
    }),
  );
}

/** Name used in the card title and in notifications: the session name, else the project. */
export function displayNameOf(s: SessionSnapshot): string {
  return s.session_name ?? projectOf(s);
}

/**
 * Attention order: waiting_permission and waiting_input first, then most recent last_event_at
 * first, ties by session_id so the order is total and stable. Returns a new array.
 */
export function sortForAttention(sessions: readonly SessionSnapshot[]): SessionSnapshot[] {
  return [...sessions].sort((a, b) => {
    const wa = isAttentionState(a.state) ? 0 : 1;
    const wb = isAttentionState(b.state) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    if (a.last_event_at !== b.last_event_at) return b.last_event_at - a.last_event_at;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
}

/** null means "all". */
export interface Filters {
  host: string | null;
  project: string | null;
}

export const NO_FILTERS: Filters = { host: null, project: null };

export function applyFilters(sessions: readonly SessionSnapshot[], f: Filters): SessionSnapshot[] {
  if (f.host === null && f.project === null) return [...sessions];
  return sessions.filter(
    (s) =>
      (f.host === null || s.host === f.host) && (f.project === null || projectOf(s) === f.project),
  );
}

/** Distinct projects, sorted. */
export function selectProjects(sessions: Record<string, SessionSnapshot>): string[] {
  return [...new Set(Object.values(sessions).map(projectOf))].sort();
}
