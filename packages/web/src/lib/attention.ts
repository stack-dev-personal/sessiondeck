import type { SessionSnapshot, SessionState } from "@sessiondeck/contract";
import { basename } from "./format";

/** The two states that wait on the user. They pin to the top of the board. */
export function isAttentionState(state: SessionState): boolean {
  return state === "waiting_permission" || state === "waiting_input";
}

/** Project name shown on the card and used by the project filter: project_dir, else cwd, else id. */
export function projectOf(s: SessionSnapshot): string {
  return basename(s.project_dir) ?? basename(s.cwd) ?? s.session_id;
}

/** Name used in the card title and in notifications: the session name, else the project. */
export function displayNameOf(s: SessionSnapshot): string {
  return s.session_name ?? projectOf(s);
}

/**
 * Attention order: waiting_permission and waiting_input first, then most recent last_event_at
 * first, ties by session_id so the order is total and stable. Returns a new array.
 *
 * @deprecated The board orders with sortDisplay (R3.10); kept for Sprint 3 references only.
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
