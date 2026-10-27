import type { SessionSnapshot } from "@sessiondeck/contract";

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

export type AtlasSession = SessionSnapshot & AtlasFields;

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
