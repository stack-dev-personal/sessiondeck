import { afterEach, describe, expect, it, vi } from "vitest";
import { setAtlasApi } from "../atlas/api";
import { createBoardStore } from "../store/board";
import { createMockAtlas, projectIdFor, rollUp } from "./atlas";
import { playTimeline } from "./player";
import { buildMockTimeline } from "./timeline";
import { atlasOf } from "../atlas/types";

afterEach(() => {
  setAtlasApi(null);
  vi.useRealTimers();
});

function settled() {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
  });
  const store = createBoardStore();
  const m = createMockAtlas(store);
  store.subscribe(m.sync);
  playTimeline(buildMockTimeline(1_792_400_000_000), store.getState().enqueue);
  vi.advanceTimersByTime(10 * 60_000);
  return { store, m };
}

describe("rollUp", () => {
  it("rolls worktree path shapes up to the repo", () => {
    expect(rollUp("/home/u/repo/.claude/worktrees/feat")).toBe("/home/u/repo");
    expect(rollUp("/home/u/repo/.worktrees/feat/pkg")).toBe("/home/u/repo");
    expect(rollUp("/home/u/repo/.git/worktrees/x")).toBe("/home/u/repo");
    expect(rollUp("/home/u/repo-wt/feat")).toBe("/home/u/repo");
    expect(rollUp("/home/u/repo-worktrees/feat")).toBe("/home/u/repo");
    expect(rollUp("/home/u/plain")).toBe("/home/u/plain");
    expect(projectIdFor("/a")).toMatch(/^p_[0-9a-f]{32}$/);
  });
});

describe("mock atlas", () => {
  it("annotates every mock session; the worktree session rolls up to its repo project", () => {
    const { store } = settled();
    const list = Object.values(store.getState().sessions);
    expect(list).toHaveLength(8);
    for (const s of list) expect(atlasOf(s).project_id).toMatch(/^p_/);
    const wt = store.getState().sessions["mock-bb2dash-1"]!;
    expect(wt.git.worktree).toBe("bb2dash-charts");
    expect(atlasOf(wt).project_name).toBe("bb2dash");
    expect(atlasOf(store.getState().sessions["mock-sessiondeck-3"]!)).toMatchObject({
      phase: "P3",
      phase_source: "inferred",
    });
    expect(atlasOf(store.getState().sessions["mock-atlas-4"]!)).toMatchObject({
      phase: "Hardening",
      phase_source: "manual",
    });
  });

  it("project detail has live rows, archived capped at 20 of 25, totals and branches", async () => {
    const { m } = settled();
    const projects = await m.api.listProjects();
    const bb = projects.find((p) => p.name === "bb2dash")!;
    expect(bb.sessions).toBe(26);
    const d = await m.api.getProject(bb.id);
    expect(d.live.map((s) => s.session_id)).toEqual(["mock-bb2dash-1"]);
    expect(d.archived).toHaveLength(20);
    expect(d.totals.sessions).toBe(26);
    expect(d.totals.hours).toBeGreaterThan(0);
    expect(d.branches.length).toBeGreaterThan(0);
  });

  it("reassigns, renames, recolors and edits phases in the board", async () => {
    const { store, m } = settled();
    const projects = await m.api.listProjects();
    const bb = projects.find((p) => p.name === "bb2dash")!;
    const other = projects.find((p) => p.name === "harvest")!;
    await m.api.setSessionProject("mock-bb2dash-1", other.id);
    expect(atlasOf(store.getState().sessions["mock-bb2dash-1"]!).project_id).toBe(other.id);
    await m.api.setSessionProject("mock-bb2dash-1", null);
    expect(atlasOf(store.getState().sessions["mock-bb2dash-1"]!).project_id).toBe(bb.id);
    await m.api.patchProject(bb.id, { name: "renamed", color: "state-idle" });
    expect(atlasOf(store.getState().sessions["mock-bb2dash-1"]!)).toMatchObject({
      project_name: "renamed",
      project_color: "state-idle",
    });
    await expect(m.api.patchProject(bb.id, { color: "red" })).rejects.toMatchObject({
      status: 400,
    });
    await m.api.setSessionPhase("mock-bb2dash-1", "Review");
    expect((await m.api.listPhases(bb.id)).map((p) => p.phase)).toContain("Review");
    await m.api.setSessionPhase("mock-bb2dash-1", null);
    expect(atlasOf(store.getState().sessions["mock-bb2dash-1"]!).phase).toBeNull();
    await expect(m.api.getProject("nope")).rejects.toMatchObject({ status: 404 });
  });
});
