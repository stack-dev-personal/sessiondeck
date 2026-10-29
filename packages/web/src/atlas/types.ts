import type { SessionSnapshot } from "@sessiondeck/contract";
import { neutralize } from "../lib/neutralize";

/**
 * Fields the hub adds to every session list, detail, WS initial and `session` delta (docs/ATLAS.md).
 * They are not in the contract snapshot, so web carries them as an extension type. Every field is
 * optional: an older hub, or a mock session before annotation, simply lacks them.
 */
export interface AtlasFields {
  project_id?: string | null;
  project_name?: string | null;
  project_color?: string | null;
  phase?: string | null;
  phase_source?: "manual" | "inferred" | null;
}

/** `snapshot.archive` as the hub stores it (R5.3): untrusted shape, parsed defensively by `archiveOf`. */
export interface ArchiveFields {
  archive?: unknown;
}

export type AtlasSession = SessionSnapshot & AtlasFields & ArchiveFields;

/** The archive record of a session, normalized and neutralized for display. */
export interface ArchiveView {
  title: string | null;
  outcome: string;
  outcomeTruncated: boolean;
  date: string | null;
  durationS: number | null;
  branch: string | null;
  commits: string[];
  prs: string[];
  tools: { name: string; count: number | null }[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const optText = (v: unknown): string | null => (typeof v === "string" ? neutralize(v) : null);
const textList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(neutralize) : [];

/**
 * The archive record of `s`, or null when it has none. All free text (title, outcome, branch,
 * commits, prs, tool names) comes back neutralized (bidi, zero-width and C1 characters made
 * visible), so callers can render it as plain React text.
 */
export function archiveOf(s: SessionSnapshot): ArchiveView | null {
  const a = (s as AtlasSession).archive;
  if (!isRec(a)) return null;
  const dur = a["duration_s"];
  return {
    title: optText(a["title"]),
    outcome: typeof a["outcome"] === "string" ? neutralize(a["outcome"]) : "",
    outcomeTruncated: a["outcome_truncated"] === true,
    date: typeof a["date"] === "string" ? a["date"] : null,
    durationS: typeof dur === "number" && Number.isFinite(dur) && dur >= 0 ? dur : null,
    branch: optText(a["branch"]),
    commits: textList(a["commits"]),
    prs: textList(a["prs"]),
    tools: Array.isArray(a["tools_used"])
      ? a["tools_used"].filter(isRec).flatMap((t) =>
          typeof t["name"] === "string"
            ? [
                {
                  name: neutralize(t["name"]),
                  count: typeof t["count"] === "number" ? t["count"] : null,
                },
              ]
            : [],
        )
      : [],
  };
}

/** True when the session has an archive record and is no longer live (the hub's `archived` row state). */
export function isArchivedState(s: SessionSnapshot): boolean {
  const st = s.state as string;
  return (
    isRec((s as AtlasSession).archive) && (st === "ended" || st === "exited" || st === "archived")
  );
}

/** One-line excerpt of the outcome for rows and cards. */
export function outcomeExcerpt(outcome: string, max = 140): string {
  const t = outcome.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export const ATLAS_KEYS = [
  "project_id",
  "project_name",
  "project_color",
  "phase",
  "phase_source",
] as const satisfies readonly (keyof AtlasFields)[];

/** Copies the atlas fields from `from` onto `to` when `to` carries none of them (older-hub delta). */
export function carryAtlas(
  to: SessionSnapshot,
  from: SessionSnapshot | undefined,
): SessionSnapshot {
  if (from === undefined) return to;
  // A board copy older than the capture lacks `archive`: the REST row's record is kept.
  const fa = (from as AtlasSession).archive;
  if (fa !== undefined && (to as AtlasSession).archive === undefined) {
    to = { ...to, archive: fa } as SessionSnapshot;
  }
  const t = to as unknown as Record<string, unknown>;
  if (ATLAS_KEYS.some((k) => k in t)) return to;
  const f = from as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...t };
  for (const k of ATLAS_KEYS) if (k in f) out[k] = f[k];
  return out as unknown as SessionSnapshot;
}

/** The atlas fields with absent ones normalized to null. */
export type AtlasView = { [K in keyof AtlasFields]-?: Exclude<AtlasFields[K], undefined> };

export function atlasOf(s: SessionSnapshot): AtlasView {
  const a = s as AtlasSession;
  return {
    project_id: a.project_id ?? null,
    project_name: a.project_name ?? null,
    project_color: a.project_color ?? null,
    phase: a.phase ?? null,
    phase_source: a.phase_source ?? null,
  };
}

export interface ProjectSummary {
  id: string;
  project_dir: string;
  name: string;
  color: string;
  vault_collection: string | null;
  sessions: number;
  live: number;
}

export interface Totals {
  sessions: number;
  hours: number;
  cost_usd: number;
}

export interface BranchCount {
  branch: string;
  sessions: number;
}

export interface PhaseCount {
  phase: string;
  sessions: number;
}

export interface ProjectDetail {
  project: ProjectSummary;
  live: AtlasSession[];
  archived: AtlasSession[];
  totals: Totals;
  branches: BranchCount[];
}

export type SearchKind = "session" | "project" | "phase";

/** One GET /search hit (docs/ATLAS.md). `title` and `snippet` are raw transcript text: render as text only. */
export interface SearchResult {
  kind: SearchKind;
  /** Session id, project id, or for a phase the phase label. */
  id: string;
  project_id: string;
  title: string;
  snippet: string;
  state?: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  took_ms: number;
}
