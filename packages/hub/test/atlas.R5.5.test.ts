import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.ts";
import { AUTH, makeHub, seedSession, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});
const patch = (url: string, payload: unknown) =>
  h.app.inject({ method: "PATCH", url, headers: AUTH, payload: payload as object });
const get = (url: string) => h.app.inject({ method: "GET", url, headers: AUTH });

describe("R5.5 phase labels", () => {
  it("manual label beats inference; null restores it; list and detail carry the phase", async () => {
    seedSession(h.store, "s1", { session_name: "P5 atlas work", project_dir: "/r/app" });
    const detail = async () =>
      (await get("/sessions/s1")).json() as { phase: string | null; phase_source: string | null };
    expect(await detail()).toMatchObject({ phase: "P5", phase_source: "inferred" });
    const r = await patch("/sessions/s1/phase", { phase: "Hardening" });
    expect(r.statusCode).toBe(200);
    expect(await detail()).toMatchObject({ phase: "Hardening", phase_source: "manual" });
    const list = (await get("/sessions")).json() as { phase: string }[];
    expect(list[0]!.phase).toBe("Hardening");
    await patch("/sessions/s1/phase", { phase: null });
    expect(await detail()).toMatchObject({ phase: "P5", phase_source: "inferred" });
  });

  it("GET /projects/:id/phases lists distinct effective phases with counts", async () => {
    seedSession(h.store, "a", { session_name: "P5 x", project_dir: "/r/app" });
    seedSession(h.store, "b", {
      project_dir: "/r/app/.worktrees/w",
      git: { branch: "p5/y", worktree: null, pr: null },
    });
    seedSession(h.store, "c", { project_dir: "/r/app" });
    await patch("/sessions/c/phase", { phase: "Polish" });
    seedSession(h.store, "d", { project_dir: "/r/app" }); // no phase
    const id = h.store.getSession("a")!.project_id!;
    const body = (await get(`/projects/${id}/phases`)).json() as { phases: unknown[] };
    expect(body.phases).toEqual([
      { phase: "P5", sessions: 2 },
      { phase: "Polish", sessions: 1 },
    ]);
    expect((await get("/projects/nope/phases")).statusCode).toBe(404);
  });

  it("rejects bad bodies and unknown sessions", async () => {
    seedSession(h.store, "s1");
    for (const body of [
      {},
      { phase: "" },
      { phase: "x".repeat(61) },
      { phase: 3 },
      { phase: "a", extra: 1 },
    ]) {
      expect((await patch("/sessions/s1/phase", body)).statusCode).toBe(400);
    }
    expect((await patch("/sessions/nope/phase", { phase: "a" })).statusCode).toBe(404);
  });

  it("survives a hub restart (file DB closed and reopened) and replay", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atlas-"));
    const file = path.join(dir, "hub.sqlite");
    try {
      let s = Store.open(file);
      s.migrate();
      seedSession(s, "s1", { session_name: "plain", project_dir: "/r/app" });
      s.ensureProject("/r/other", "other", "#abcdef");
      const other = s.listProjectSummaries(10).find((p) => p.name === "other")!;
      expect(s.setSessionPhase("s1", "Release")).toBe(true);
      expect(s.setSessionProject("s1", other.id)).toBe(true);
      expect(s.patchProject(other.id, { name: "Renamed", color: "#010203" })).toBe(true);
      s.close();

      s = Store.open(file);
      expect(s.migrate()).toEqual([]);
      expect(s.getSession("s1")).toMatchObject({ phase_label: "Release", project_id: other.id });
      expect(s.getProject(other.id)).toMatchObject({ name: "Renamed", color: "#010203" });
      // replay rebuilds sessions from events: overrides live outside the sessions table
      s.deleteAllSessions();
      seedSession(s, "s1", { session_name: "plain", project_dir: "/r/app" });
      expect(s.getSession("s1")).toMatchObject({ phase_label: "Release", project_id: other.id });
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
