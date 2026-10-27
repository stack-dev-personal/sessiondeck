import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH, makeHub, seedSession, type TestHub } from "./support/hub.ts";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
let h: TestHub;
beforeEach(async () => {
  h = await makeHub({}, () => NOW);
});
afterEach(async () => {
  await h.cleanup();
});
const get = (url: string, headers: Record<string, string> = AUTH) =>
  h.app.inject({ method: "GET", url, headers });
const patch = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  h.app.inject({ method: "PATCH", url, headers, payload: payload as object });

const git = (branch: string | null) => ({ branch, worktree: null, pr: null });

function seed() {
  const dir = "/r/app";
  seedSession(h.store, "live1", {
    project_dir: dir,
    state: "working",
    started_at: NOW - 2 * H,
    last_event_at: NOW - 1000,
    git: git("main"),
  });
  seedSession(h.store, "live2", {
    project_dir: `${dir}/.claude/worktrees/w`,
    state: "idle",
    started_at: NOW - H,
    last_event_at: NOW - 1000,
    git: git("feat/x"),
  });
  seedSession(h.store, "live3", {
    project_dir: dir,
    state: "idle",
    started_at: NOW - H,
    last_event_at: NOW - 1000,
    git: git("main"),
  });
  // ended long ago: neither live nor active branch
  seedSession(h.store, "gone", {
    project_dir: dir,
    state: "ended",
    state_since: NOW - 49 * H,
    started_at: NOW - 50 * H,
    last_event_at: NOW - 49 * H,
    git: git("old"),
  });
  for (let i = 0; i < 25; i++) {
    const id = `arch${String(i).padStart(2, "0")}`;
    seedSession(h.store, id, {
      project_dir: dir,
      state: "archived" as never,
      started_at: NOW - (100 + i) * H,
      last_event_at: NOW - (99 + i) * H,
      git: git(`arch-${i}`),
    });
  }
  seedSession(h.store, "other", {
    project_dir: "/r/other",
    state: "working",
    started_at: NOW - H,
    last_event_at: NOW - 10,
  });
  return h.store.getSession("live1")!.project_id!;
}

describe("R5.6 project view", () => {
  it("returns live, last 20 archived newest first, totals and active branches", async () => {
    const id = seed();
    const r = await get(`/projects/${id}`);
    expect(r.statusCode).toBe(200);
    const v = r.json() as {
      project: { id: string; name: string };
      live: { session_id: string; project_id: string }[];
      archived: { session_id: string }[];
      totals: { sessions: number; hours: number; cost_usd: number };
      branches: { branch: string; sessions: number }[];
    };
    expect(v.project).toMatchObject({ id, name: "app" });
    expect(v.live.map((s) => s.session_id).sort()).toEqual(["live1", "live2", "live3"]);
    expect(v.live.every((s) => s.project_id === id)).toBe(true);
    expect(v.archived).toHaveLength(20);
    expect(v.archived[0]!.session_id).toBe("arch00"); // newest ended_at/last_event_at first
    expect(v.archived[19]!.session_id).toBe("arch19");
    expect(v.totals.sessions).toBe(29);
    // hours: live1 2h less 1 s, live2/3 1h less 1 s each, gone 1h, 25 archived 1h each
    expect(v.totals.hours).toBeCloseTo(30, 2);
    expect(v.totals.cost_usd).toBe(0); // no transcript usage rows seeded
    expect(v.branches).toEqual([
      { branch: "main", sessions: 2 },
      { branch: "feat/x", sessions: 1 },
    ]);
  });

  it("empty archive today: archived is []; unknown project 404", async () => {
    seedSession(h.store, "s", {
      project_dir: "/r/z",
      state: "working",
      started_at: NOW - H,
      last_event_at: NOW,
    });
    const id = h.store.getSession("s")!.project_id!;
    expect((await get(`/projects/${id}`)).json()).toMatchObject({ archived: [] });
    expect((await get("/projects/p_nope")).statusCode).toBe(404);
  });

  it("totals cost comes from transcript history", async () => {
    seedSession(h.store, "c1", { project_dir: "/r/cost", state: "idle" });
    const id = h.store.getSession("c1")!.project_id!;
    const line = JSON.stringify({
      timestamp: "2026-01-02T03:04:05.000Z",
      sessionId: "c1",
      requestId: "rq1",
      message: {
        id: "m1",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 1000, output_tokens: 1000 },
      },
      costUSD: 0.5,
    });
    h.store.db
      .prepare(
        "INSERT INTO transcript_lines (session_id, agent_id, line_no, ts, raw) VALUES (?, '', 0, 1, ?)",
      )
      .run("c1", line);
    const v = (await get(`/projects/${id}`)).json() as { totals: { cost_usd: number } };
    expect(v.totals.cost_usd).toBeGreaterThan(0);
  });

  it("GET /projects lists id, counts, name and color", async () => {
    seed();
    const list = (await get("/projects")).json() as {
      projects: {
        project_dir: string;
        sessions: number;
        live: number;
        id: string;
        color: string;
      }[];
    };
    const app = list.projects.find((p) => p.project_dir === "/r/app")!;
    expect(app).toMatchObject({ sessions: 29, live: 3 });
    expect(app.id).toMatch(/^p_/);
    expect(app.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("manual reassignment moves the session between project views", async () => {
    const id = seed();
    const other = h.store.getSession("other")!.project_id!;
    const r = await patch("/sessions/live1/project", { project_id: other });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ project_id: other, project_name: "other" });
    const v = (await get(`/projects/${id}`)).json() as { live: unknown[] };
    expect(v.live).toHaveLength(2);
    expect((await patch("/sessions/live1/project", { project_id: "p_nope" })).statusCode).toBe(404);
    expect((await patch("/sessions/nope/project", { project_id: other })).statusCode).toBe(404);
  });
});

describe("R5.1/R5.6 PATCH validation and auth", () => {
  it("PATCH /projects/:id edits name, color (hex or token) and vault_collection", async () => {
    const id = seed();
    const ok = await patch(`/projects/${id}`, {
      name: "Renamed",
      color: "#A1b2C3",
      vault_collection: "vault-x",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      project: { name: "Renamed", color: "#A1b2C3", vault_collection: "vault-x" },
    });
    expect((await patch(`/projects/${id}`, { color: "accent-blue" })).statusCode).toBe(200);
    expect((await patch(`/projects/${id}`, { vault_collection: null })).json()).toMatchObject({
      project: { vault_collection: null },
    });
  });

  it("rejects bad color, long or empty name, empty and unknown-key bodies", async () => {
    const id = seed();
    for (const body of [
      { color: "red!" },
      { color: "#12345" },
      { color: "#gggggg" },
      { color: "#1234567" },
      { color: "'; DROP TABLE projects;--" },
      { name: "x".repeat(81) },
      { name: "   " },
      {},
      { nope: 1 },
    ]) {
      expect((await patch(`/projects/${id}`, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await patch("/projects/p_nope", { name: "a" })).statusCode).toBe(404);
  });

  it("every write route is 401 with an empty body without the bearer token", async () => {
    const id = seed();
    for (const [url, body] of [
      [`/projects/${id}`, { name: "x" }],
      ["/sessions/live1/project", { project_id: id }],
      ["/sessions/live1/phase", { phase: "x" }],
    ] as const) {
      for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
        const r = await patch(url, body, headers);
        expect([r.statusCode, r.body]).toEqual([401, ""]);
      }
    }
    expect(h.store.getProject(id)!.name).toBe("app"); // nothing was written
    for (const url of [`/projects/${id}`, `/projects/${id}/phases`]) {
      expect((await get(url, {})).statusCode).toBe(401);
    }
  });
});
