import { describe, expect, it } from "vitest";
import { createSnapshot } from "@sessiondeck/contract";
import { inferPhase, inferProject, normalizeSeparators } from "../src/atlas/infer.ts";
import { rowOf } from "../src/ingest/ingestor.ts";
import { Store } from "../src/db/store.ts";
import { tempStore } from "./helpers.ts";
import { seedSession } from "./support/hub.ts";

describe("R5.1 worktree roll-up (path table)", () => {
  const cases: [string, string, string][] = [
    ["/home/u/code/app", "/home/u/code/app", "app"],
    ["/home/u/code/app/", "/home/u/code/app", "app"],
    ["/home/u/code/app/.claude/worktrees/feat-x", "/home/u/code/app", "app"],
    ["/home/u/code/app/.claude/worktrees/feat-x/src/deep", "/home/u/code/app", "app"],
    ["/home/u/code/app/.worktrees/fix", "/home/u/code/app", "app"],
    ["/home/u/code/app-wt/feat", "/home/u/code/app", "app"],
    ["/home/u/code/app/.git/worktrees/x", "/home/u/code/app", "app"],
    ["C:\\Users\\user\\code\\App", "c:/users/user/code/app", "App"],
    ["c:/Users/user/code/App/", "c:/users/user/code/app", "App"],
    ["C:\\Users\\user\\code\\App\\.claude\\worktrees\\feat", "c:/users/user/code/app", "App"],
    ["c:\\Users\\User\\code\\App-wt\\feat", "c:/users/user/code/app", "App"],
    ["/mnt/c/Users/user/code/App/.worktrees/a", "c:/users/user/code/app", "App"],
  ];
  it.each(cases)("%s -> %s", (input, key, name) => {
    const p = inferProject(input, null);
    expect(p.key).toBe(key);
    expect(p.name).toBe(name);
  });

  it("project_dir wins over cwd; cwd is the fallback; neither is Unassigned", () => {
    expect(inferProject("/a/b", "/c/d").key).toBe("/a/b");
    expect(inferProject(null, "/c/d").key).toBe("/c/d");
    expect(inferProject("", null).name).toBe("Unassigned");
  });

  it("a repo directory that merely contains 'worktrees' is not rolled up", () => {
    expect(inferProject("/x/worktrees/app", null).key).toBe("/x/worktrees/app");
    expect(inferProject("/x/app-wt", null).key).toBe("/x/app-wt"); // no <name> below the container
  });

  it("documented limit: a cwd fallback below a sibling worktree root does not roll up", () => {
    expect(inferProject(null, "/x/repo-wt/feat/packages/hub").name).toBe("hub");
    expect(inferProject("/x/repo-wt/feat", "/x/repo-wt/feat/packages/hub").name).toBe("repo");
  });

  it("strips zero-width, directional-mark and line-separator characters; slices by code point", () => {
    expect(inferProject("/x/a\u200Bb\u200E\u200F\u061C\uFEFF\u2028\u2029c", null).name).toBe("abc");
    const name = inferProject(`/x/${"\u{1F600}".repeat(100)}`, null).name;
    expect(Array.from(name)).toHaveLength(80);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("sibling -wt rule applies only to the parent of the final segment", () => {
    // a repo that is itself called foo-wt, with a deeper cwd, stays itself
    expect(inferProject("/home/u/foo-wt/packages/x", null).key).toBe("/home/u/foo-wt/packages/x");
    expect(inferProject(null, "/home/u/foo-wt/packages/x").rolledUp).toBe(false);
    // early -wt segment does not roll up the whole tail
    expect(inferProject("/a-wt/b/c/d", null).rolledUp).toBe(false);
  });

  it("inferred names are capped, control and bidi characters stripped", () => {
    const p = inferProject(`/x/${"a".repeat(500)}`, null);
    expect(p.name).toHaveLength(80);
    expect(inferProject("/x/ev\u202eil\u0007\u009f", null).name).toBe("evil");
  });

  it("default color is deterministic #rrggbb", () => {
    expect(inferProject("/a/b", null).color).toBe(inferProject("/a/b", null).color);
    expect(inferProject("/a/b", null).color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("normalizeSeparators", () => {
    expect(normalizeSeparators("D:\\\\x\\y\\")).toBe("d:/x/y");
  });
});

describe("R5.1 every session has exactly one project", () => {
  it("worktree sessions of two OS styles share the repo project; ingest-time assignment", () => {
    const { store, cleanup } = tempStore();
    store.migrate();
    seedSession(store, "a", { project_dir: "/r/app" });
    seedSession(store, "b", { project_dir: "/r/app/.claude/worktrees/w1" });
    seedSession(store, "c", { project_dir: null, cwd: "/r/app-wt/w2" });
    seedSession(store, "w1", { project_dir: "C:\\code\\Tool" });
    seedSession(store, "w2", { project_dir: "c:/code/tool/.worktrees/x" });
    seedSession(store, "n", { project_dir: null, cwd: "" });
    const pid = (id: string) => store.getSession(id)!.project_id;
    expect(pid("a")).toBeTruthy();
    expect(pid("b")).toBe(pid("a"));
    expect(pid("c")).toBe(pid("a"));
    expect(pid("w2")).toBe(pid("w1"));
    expect(pid("w1")).not.toBe(pid("a"));
    const rows = store.db.prepare("SELECT session_id, project_id FROM sessions").all() as {
      project_id: string | null;
    }[];
    expect(rows.every((r) => typeof r.project_id === "string")).toBe(true);
    const names = store.listProjectSummaries(100).map((p) => p.name);
    expect(names.sort()).toEqual(["Tool", "Unassigned", "app"]);
    cleanup();
  });

  it("a later project_dir re-derives the project; a manual override wins over later ingest", () => {
    const { store, cleanup } = tempStore();
    store.migrate();
    const first = seedSession(store, "s", { project_dir: null, cwd: "/q/one" });
    const p1 = store.getSession("s")!.project_id;
    seedSession(store, "s", { project_dir: "/q/two" });
    const p2 = store.getSession("s")!.project_id;
    expect(p2).not.toBe(p1);
    store.ensureProject("/q/manual", "manual", "#112233");
    const target = store.listProjectSummaries(10).find((p) => p.project_dir === "/q/manual")!;
    expect(store.setSessionProject("s", target.id)).toBe(true);
    store.upsertSession(rowOf({ ...first, project_dir: "/q/three" }));
    expect(store.getSession("s")!.project_id).toBe(target.id);
    // clearing the override re-infers
    expect(store.setSessionProject("s", null)).toBe(true);
    expect(
      store.listProjectSummaries(10).find((p) => p.id === store.getSession("s")!.project_id)!
        .project_dir,
    ).toBe("/q/three");
    cleanup();
  });

  it("backfills sessions that predate migration 6", () => {
    const s = Store.open(":memory:");
    s.migrateCeiling = 5;
    s.migrate();
    const ins = s.db.prepare(
      "INSERT INTO sessions (session_id, host, snapshot, state, project_dir, started_at, last_event_at) VALUES (?, 'h', ?, 'idle', ?, 1, 2)",
    );
    const snap = (cwd: string) =>
      JSON.stringify(createSnapshot({ session_id: "x", host: "h", cwd, ts: 1 }));
    ins.run("o1", snap("/z/app"), "/z/app");
    ins.run("o2", snap("/z/app/.claude/worktrees/b"), "/z/app/.claude/worktrees/b");
    ins.run("o3", snap("C:\\z\\Other"), null);
    s.db.prepare("INSERT INTO projects (project_dir, name) VALUES ('/legacy', 'Legacy')").run();
    s.migrateCeiling = Number.MAX_SAFE_INTEGER;
    expect(s.migrate()).toEqual([6, 7, 8]);
    const pid = (id: string) => s.getSession(id)!.project_id;
    expect(pid("o1")).toBeTruthy();
    expect(pid("o2")).toBe(pid("o1"));
    expect(pid("o3")).toBeTruthy();
    expect(pid("o3")).not.toBe(pid("o1"));
    const list = s.listProjectSummaries(10);
    expect(list.every((p) => p.id.startsWith("p_"))).toBe(true);
    expect(list.find((p) => p.project_dir === "/legacy")!.name).toBe("Legacy");
    expect(s.backfillAtlas()).toBe(0); // idempotent
    // R5.4: migration 7 indexes what was already there (sessions by cwd basename, legacy project by name).
    expect(s.search("legacy", 5).map((h) => h.kind)).toEqual(["project"]);
    expect(s.search("app", 5).some((h) => h.kind === "session" || h.kind === "project")).toBe(true);
    s.close();
  });
});

describe("R5.5 phase inference", () => {
  it.each([
    ["P5 atlas", null, "P5"],
    ["work on phase 3 things", null, "P3"],
    ["Phase  12", null, "P12"],
    ["nothing", "p7/atlas-core", "P7"],
    ["nothing", "feature/p7", null],
    ["Python 3", null, null],
    ["p95 latency fix", null, null],
    ["P95 latency", "p95/x", "P95"], // branch prefix still applies when the name is a metric
    ["P95  latency", null, null], // two spaces: no backtracking bypass
    ["P95 \tms", null, null],
    ["P95 \t latency", "p95/x", "P95"],
    ["P5: atlas", null, "P5"],
    ["P5-atlas", null, "P5"],
    ["P5/atlas", null, "P5"],
    ["P5", null, "P5"],
  ])("%s / %s -> %s", (name, branch, want) => {
    expect(inferPhase(name, branch)).toBe(want);
  });
});
