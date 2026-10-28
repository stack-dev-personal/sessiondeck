import { createSnapshot } from "@sessiondeck/contract";
import { vi, type Mock } from "vitest";
import type { AtlasApi } from "./api";
import type { AtlasSession, ProjectDetail, ProjectSummary } from "./types";

/** Test helpers: a spy-backed AtlasApi and snapshot builders. Not imported by app code. */
export const NOW = 1_792_400_000_000;

export function session(id: string, over: Partial<AtlasSession> = {}): AtlasSession {
  return {
    ...createSnapshot({ session_id: id, host: "h1", cwd: `/w/${id}`, ts: NOW - 3_600_000 }),
    state: "idle",
    session_name: `name-${id}`,
    git: { branch: "main", worktree: null, pr: null },
    project_id: "p_a",
    project_name: "alpha",
    project_color: "#3e63dd",
    phase: null,
    phase_source: null,
    ...over,
  };
}

export const PROJECTS: ProjectSummary[] = [
  {
    id: "p_a",
    project_dir: "/w/alpha",
    name: "alpha",
    color: "#3e63dd",
    vault_collection: null,
    sessions: 30,
    live: 2,
  },
  {
    id: "p_b",
    project_dir: "/w/beta",
    name: "beta",
    color: "state-idle",
    vault_collection: null,
    sessions: 1,
    live: 1,
  },
];

export function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    project: PROJECTS[0]!,
    live: [
      session("s1", { phase: "P3", phase_source: "inferred" }),
      session("s2", { phase: "Hardening", phase_source: "manual", state: "working" }),
    ],
    archived: Array.from({ length: 25 }, (_, i) =>
      session(`old-${i + 1}`, {
        state: "ended",
        last_event_at: NOW - i * 1000,
        session_name: `old ${i + 1}`,
      }),
    ),
    totals: { sessions: 27, hours: 12.345, cost_usd: 1234.5 },
    branches: [
      { branch: "main", sessions: 1 },
      { branch: "feat/x", sessions: 1 },
    ],
    ...over,
  };
}

export type FakeApi = { [K in keyof AtlasApi]: Mock<AtlasApi[K]> };

export function fakeApi(over: Partial<AtlasApi> = {}): FakeApi {
  const base: AtlasApi = {
    listProjects: vi.fn(async () => PROJECTS),
    getProject: vi.fn(async () => detail()),
    patchProject: vi.fn(async (_id: string, patch: { name?: string; color?: string }) => ({
      ...PROJECTS[0]!,
      ...patch,
    })),
    listPhases: vi.fn(async () => [
      { phase: "P3", sessions: 1 },
      { phase: "Hardening", sessions: 1 },
    ]),
    setSessionProject: vi.fn(async (id: string, projectId: string | null) =>
      session(id, { project_id: projectId ?? "p_a" }),
    ),
    setSessionPhase: vi.fn(async (id: string, phase: string | null) =>
      session(id, { phase, phase_source: phase ? "manual" : null }),
    ),
    listSessions: vi.fn(async () => [] as AtlasSession[]),
    search: vi.fn(async () => ({ results: [], took_ms: 0 })),
    ...over,
  };
  return Object.fromEntries(
    Object.entries(base).map(([k, f]) => [k, vi.isMockFunction(f) ? f : vi.fn(f as never)]),
  ) as FakeApi;
}
