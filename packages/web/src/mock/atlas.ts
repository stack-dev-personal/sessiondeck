import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import type { StoreApi, UseBoundStore } from "zustand";
import { AtlasError, setAtlasApi, type AtlasApi } from "../atlas/api";
import { isValidColor } from "../atlas/color";
import {
  ATLAS_KEYS,
  atlasOf,
  type AtlasSession,
  type BranchCount,
  type PhaseCount,
  type ProjectDetail,
  type ProjectSummary,
} from "../atlas/types";
import { basename } from "../lib/format";
import type { BoardState } from "../store/board";

/**
 * Mock-mode atlas: serves the hub's project and phase endpoints from the mock sessions, in memory
 * (a reload starts over; the live variant of the R5.5 spec proves persistence against a real hub).
 * Projects come from the same path rules the hub applies (docs/ATLAS.md): worktrees roll up to the
 * repo. Mock sessions carry no worktree path, so a session whose git.worktree differs from its
 * project directory name is placed under `<project_dir>/.claude/worktrees/<worktree>`.
 */

const stripTrailing = (p: string) =>
  p
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");

/** Repo root for a path, per the worktree rules in docs/ATLAS.md. */
export function rollUp(path: string): string {
  const p = stripTrailing(path);
  for (const marker of ["/.claude/worktrees/", "/.worktrees/", "/.git/worktrees/"]) {
    const i = p.indexOf(marker);
    if (i > 0) return p.slice(0, i);
  }
  const parts = p.split("/");
  const last = parts.length - 1;
  if (last >= 2) {
    const container = parts[last - 1]!;
    for (const suffix of ["-wt", "-worktrees"]) {
      if (container.endsWith(suffix) && container.length > suffix.length) {
        return [...parts.slice(0, last - 1), container.slice(0, -suffix.length)].join("/");
      }
    }
  }
  return p;
}

function hash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function projectIdFor(key: string): string {
  return `p_${[1, 2, 3, 4]
    .map((n) =>
      hash32(key, 2166136261 * n)
        .toString(16)
        .padStart(8, "0"),
    )
    .join("")}`;
}

const PALETTE = [
  "#3e63dd",
  "#12a594",
  "#d6409f",
  "#e5484d",
  "#f76b15",
  "#8e4ec6",
  "#30a46c",
  "#0090ff",
];

function inferPhase(s: SessionSnapshot): string | null {
  const m = /^p(\d+)\//i.exec(s.git.branch ?? "") ?? /^P(\d+)\b/.exec(s.session_name ?? "");
  return m ? `P${m[1]}` : null;
}

interface Archived {
  snap: SessionSnapshot;
  key: string;
}

const NOW0 = Date.now();

function seedArchived(): Archived[] {
  const key = "/home/dev/projects/bb2dash";
  return Array.from({ length: 25 }, (_, i) => {
    const n = i + 1;
    const ended = NOW0 - n * 6 * 3_600_000;
    const snap = createSnapshot({
      session_id: `mock-archived-${String(n).padStart(2, "0")}`,
      host: n % 2 === 0 ? "stack-lap" : "stack-box",
      cwd: key,
      ts: ended - (40 + n) * 60_000,
    });
    snap.project_dir = key;
    snap.session_name = `Archived run ${n}`;
    snap.state = "ended";
    snap.state_since = ended;
    snap.last_event_at = ended;
    snap.git.branch = n % 3 === 0 ? "main" : `feat/old-${n}`;
    snap.cost.usd = 0.4 + n * 0.11;
    return { snap, key };
  });
}

export interface MockAtlas {
  api: AtlasApi;
  /** Annotates every board session; call after the board changes. Idempotent. */
  sync: () => void;
}

export function createMockAtlas(store: UseBoundStore<StoreApi<BoardState>>): MockAtlas {
  const names = new Map<string, string>();
  const colors = new Map<string, string>();
  const sessionProject = new Map<string, string | null>();
  const sessionPhase = new Map<string, string | null>([["mock-atlas-4", "Hardening"]]);
  const archived = seedArchived();
  const keyOfId = new Map<string, string>();

  const sourcePath = (s: SessionSnapshot): string | null => {
    const dir = s.project_dir ?? (s.cwd || null);
    if (dir === null) return null;
    const wt = s.git.worktree;
    return wt && wt !== basename(dir) ? `${stripTrailing(dir)}/.claude/worktrees/${wt}` : dir;
  };
  const keyOf = (s: SessionSnapshot): string | null => {
    const p = sourcePath(s);
    return p === null ? null : rollUp(p);
  };
  const ensure = (key: string | null): string => {
    const k = key ?? "Unassigned";
    const id = projectIdFor(k);
    keyOfId.set(id, k);
    return id;
  };
  const nameOf = (id: string): string => {
    const k = keyOfId.get(id) ?? "Unassigned";
    return names.get(id) ?? (basename(k) || k);
  };
  const colorOf = (id: string): string =>
    colors.get(id) ?? PALETTE[hash32(keyOfId.get(id) ?? "", 2166136261) % PALETTE.length]!;

  const projectOfSession = (s: SessionSnapshot, archivedKey?: string): string => {
    if (sessionProject.has(s.session_id)) {
      const o = sessionProject.get(s.session_id)!;
      if (o !== null) return o;
    }
    return ensure(archivedKey ?? keyOf(s));
  };

  const annotate = (s: SessionSnapshot, archivedKey?: string): AtlasSession => {
    const pid = projectOfSession(s, archivedKey);
    const manual = sessionPhase.get(s.session_id) ?? null;
    const inferred = inferPhase(s);
    const phase = manual ?? inferred;
    return {
      ...s,
      project_id: pid,
      project_name: nameOf(pid),
      project_color: colorOf(pid),
      phase,
      phase_source: manual !== null ? "manual" : inferred !== null ? "inferred" : null,
    };
  };

  const same = (a: SessionSnapshot, b: SessionSnapshot): boolean => {
    const x = a as unknown as Record<string, unknown>;
    const y = b as unknown as Record<string, unknown>;
    return ATLAS_KEYS.every((k) => x[k] === y[k]);
  };

  const sync = (): void => {
    const cur = store.getState().sessions;
    let next: Record<string, SessionSnapshot> | null = null;
    for (const [id, s] of Object.entries(cur)) {
      let a: AtlasSession;
      try {
        a = annotate(s);
      } catch {
        continue; // a malformed session is the board's problem (ErrorBoundary), not the annotator's
      }
      if (!same(s, a)) {
        next ??= { ...cur };
        next[id] = { ...s, ...pick(a) } as SessionSnapshot;
      }
    }
    if (next) store.setState({ sessions: next });
  };

  const live = (): SessionSnapshot[] => Object.values(store.getState().sessions);
  const isLive = (s: SessionSnapshot) => s.state !== "ended" && s.state !== "exited";

  const allProjects = (): ProjectSummary[] => {
    const counts = new Map<string, { sessions: number; live: number }>();
    const bump = (id: string, lv: boolean) => {
      const c = counts.get(id) ?? { sessions: 0, live: 0 };
      c.sessions += 1;
      if (lv) c.live += 1;
      counts.set(id, c);
    };
    for (const s of live()) bump(projectOfSession(s), isLive(s));
    for (const a of archived) bump(projectOfSession(a.snap, a.key), false);
    for (const id of keyOfId.keys()) if (!counts.has(id)) counts.set(id, { sessions: 0, live: 0 });
    return [...counts].map(([id, c]) => ({
      id,
      project_dir: keyOfId.get(id) ?? "",
      name: nameOf(id),
      color: colorOf(id),
      vault_collection: null,
      sessions: c.sessions,
      live: c.live,
    }));
  };

  const find = (sid: string): { s: SessionSnapshot; key?: string } | undefined => {
    const b = store.getState().sessions[sid];
    if (b) return { s: b };
    const a = archived.find((x) => x.snap.session_id === sid);
    return a ? { s: a.snap, key: a.key } : undefined;
  };

  const projectOr404 = (id: string): ProjectSummary => {
    const p = allProjects().find((x) => x.id === id);
    if (!p) throw new AtlasError(404, "Not found");
    return p;
  };

  const api: AtlasApi = {
    listProjects: async () =>
      allProjects().sort((a, b) => a.project_dir.localeCompare(b.project_dir)),
    getProject: async (id): Promise<ProjectDetail> => {
      const project = projectOr404(id);
      const liveRows = live()
        .filter((s) => projectOfSession(s) === id)
        .map((s) => annotate(s));
      const arch = archived
        .filter((a) => projectOfSession(a.snap, a.key) === id)
        .sort((a, b) => b.snap.last_event_at - a.snap.last_event_at)
        .map((a) => annotate(a.snap, a.key));
      const all = [...liveRows, ...arch];
      const counts = new Map<string, number>();
      for (const s of liveRows) {
        const b = s.git.branch;
        if (isLive(s) && b) counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      const branches: BranchCount[] = [...counts]
        .map(([branch, sessions]) => ({ branch, sessions }))
        .sort((a, b) => b.sessions - a.sessions || a.branch.localeCompare(b.branch));
      return {
        project,
        live: liveRows,
        archived: arch.slice(0, 20),
        totals: {
          sessions: all.length,
          hours: all.reduce(
            (h, s) => h + Math.max(0, s.last_event_at - s.started_at) / 3_600_000,
            0,
          ),
          cost_usd: all.reduce((c, s) => c + (s.cost.usd ?? 0), 0),
        },
        branches,
      };
    },
    patchProject: async (id, patch) => {
      projectOr404(id);
      if (patch.name !== undefined) {
        const n = patch.name.trim();
        if (n === "" || n.length > 80) throw new AtlasError(400, "Invalid name");
        names.set(id, n);
      }
      if (patch.color !== undefined) {
        if (!isValidColor(patch.color)) throw new AtlasError(400, "Invalid color");
        colors.set(id, patch.color);
      }
      sync();
      return projectOr404(id);
    },
    listPhases: async (id): Promise<PhaseCount[]> => {
      projectOr404(id);
      const counts = new Map<string, number>();
      const rows = [
        ...live().filter((s) => projectOfSession(s) === id),
        ...archived.filter((a) => projectOfSession(a.snap, a.key) === id).map((a) => a.snap),
      ];
      for (const s of rows) {
        const p = annotate(s, archived.find((a) => a.snap === s)?.key).phase;
        if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      return [...counts]
        .map(([phase, sessions]) => ({ phase, sessions }))
        .sort((a, b) => a.phase.localeCompare(b.phase, "en", { numeric: true }));
    },
    setSessionProject: async (sid, projectId) => {
      const hit = find(sid);
      if (!hit) throw new AtlasError(404, "Not found");
      if (projectId !== null) projectOr404(projectId);
      sessionProject.set(sid, projectId);
      sync();
      return annotate(hit.s, hit.key);
    },
    setSessionPhase: async (sid, phase) => {
      const hit = find(sid);
      if (!hit) throw new AtlasError(404, "Not found");
      const p = phase === null ? null : phase.trim();
      if (p !== null && (p === "" || p.length > 60)) throw new AtlasError(400, "Invalid phase");
      sessionPhase.set(sid, p);
      sync();
      return annotate(hit.s, hit.key);
    },
  };
  return { api, sync };
}

function pick(a: AtlasSession): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  const v = atlasOf(a);
  for (const k of ATLAS_KEYS) r[k] = v[k];
  return r;
}

/** Mock mode entry: installs the mock api and keeps the board's sessions annotated as they arrive. */
export function installMockAtlas(store: UseBoundStore<StoreApi<BoardState>>): () => void {
  const m = createMockAtlas(store);
  setAtlasApi(m.api);
  m.sync();
  const unsub = store.subscribe(m.sync);
  return () => {
    unsub();
    setAtlasApi(null);
  };
}
