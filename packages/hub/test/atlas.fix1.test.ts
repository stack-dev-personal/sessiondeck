import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot, StreamMessage } from "@sessiondeck/contract";
import { WebSocket } from "ws";
import { Store } from "../src/db/store.ts";
import { projectIdOf } from "../src/atlas/infer.ts";
import { AUTH, batch, makeHub, mkEnv, seedSession, type TestHub } from "./support/hub.ts";

const NOW = 1_800_000_000_000;
let h: TestHub;
const open: WebSocket[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(5);
  }
}
type Ann = SessionSnapshot & { project_id?: string; project_name?: string; phase?: string };
async function connect(): Promise<StreamMessage[]> {
  const { ws: base } = await h.listen();
  const ws = new WebSocket(`${base}/stream`, [], { headers: AUTH });
  open.push(ws);
  const msgs: StreamMessage[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as StreamMessage));
  await waitFor(() => msgs.length > 0);
  return msgs;
}
const deltas = (m: StreamMessage[]): Ann[] =>
  m.flatMap((x) => (x.type === "session" ? [x.data as Ann] : []));
const patch = (url: string, payload: unknown) =>
  h.app.inject({ method: "PATCH", url, headers: AUTH, payload: payload as object });

beforeEach(async () => {
  h = await makeHub({}, () => NOW);
});
afterEach(async () => {
  for (const w of open.splice(0)) w.terminate();
  await h.cleanup();
});

describe("R5.1/R5.5/R5.6 WS deltas carry project and phase", () => {
  it("ingest delta is annotated; PATCH phase, project and project rename push annotated deltas", async () => {
    const msgs = await connect();
    const e = mkEnv({
      session_id: "w1",
      payload: { prompt: "x", cwd: "/r/app" },
    });
    expect((await h.post(batch([e]))).statusCode).toBe(200);
    await waitFor(() => deltas(msgs).length === 1);
    const d0 = deltas(msgs)[0]!;
    expect(d0.project_id).toMatch(/^p_[0-9a-f]{32}$/);
    expect(d0.project_name).toBe("app");

    expect((await patch("/sessions/w1/phase", { phase: "Hardening" })).statusCode).toBe(200);
    await waitFor(() => deltas(msgs).length === 2);
    expect(deltas(msgs)[1]).toMatchObject({
      session_id: "w1",
      phase: "Hardening",
      project_name: "app",
    });

    expect((await patch(`/projects/${d0.project_id}`, { name: "Renamed" })).statusCode).toBe(200);
    await waitFor(() => deltas(msgs).length === 3);
    expect(deltas(msgs)[2]).toMatchObject({ project_name: "Renamed", phase: "Hardening" });

    h.store.ensureProject("/r/other", "other", "#112233");
    const other = h.store.listProjectSummaries(10).find((p) => p.name === "other")!;
    expect((await patch("/sessions/w1/project", { project_id: other.id })).statusCode).toBe(200);
    await waitFor(() => deltas(msgs).length === 4);
    expect(deltas(msgs)[3]).toMatchObject({ project_id: other.id, project_name: "other" });
  });
});

describe("PATCH rate limit and validation", () => {
  it("PATCH is charged to the read bucket", async () => {
    seedSession(h.store, "s1");
    let limited = 0;
    for (let i = 0; i < 400; i++) {
      const r = await patch("/sessions/s1/phase", { phase: "a" });
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("strips control and bidi characters from names and phases; rejects empty-after-strip", async () => {
    seedSession(h.store, "s1", { project_dir: "/r/app" });
    const id = h.store.getSession("s1")!.project_id!;
    const r = await patch("/sessions/s1/phase", { phase: "Ha‮rd\u0007" });
    expect((r.json() as { phase: string }).phase).toBe("Hard");
    await patch(`/projects/${id}`, { name: "⁦Na\u0000me⁩" });
    expect(h.store.getProject(id)!.name).toBe("Name");
    expect((await patch("/sessions/s1/phase", { phase: "‮\u0007" })).statusCode).toBe(400);
  });

  it("color accepts #rrggbb and palette tokens only; vault_collection is a safe slug", async () => {
    seedSession(h.store, "s1", { project_dir: "/r/app" });
    const id = h.store.getSession("s1")!.project_id!;
    for (const c of ["#aabbcc", "state-idle", "accent"]) {
      expect((await patch(`/projects/${id}`, { color: c })).statusCode).toBe(200);
    }
    for (const c of ["transparent", "inherit", "currentcolor", "red", "#abc"]) {
      expect((await patch(`/projects/${id}`, { color: c })).statusCode).toBe(400);
    }
    for (const v of ["vault_1.x", "a-b"]) {
      expect((await patch(`/projects/${id}`, { vault_collection: v })).statusCode).toBe(200);
    }
    for (const v of ["../x", "a/b", "a\\b", "..", "a..b", "", "x".repeat(101), "a b"]) {
      expect((await patch(`/projects/${id}`, { vault_collection: v })).statusCode).toBe(400);
    }
    expect((await patch(`/projects/${id}`, { vault_collection: null })).statusCode).toBe(200);
  });
});

describe("project id collisions", () => {
  it("ids are 128-bit hex; a forced id collision still commits the ingest batch", async () => {
    expect(projectIdOf("/a")).toMatch(/^p_[0-9a-f]{32}$/);
    h.store.projectIdFn = () => "p_collide";
    const r1 = await h.post(
      batch([mkEnv({ session_id: "c1", payload: { prompt: "x", cwd: "/r/one" } })]),
    );
    const r2 = await h.post(
      batch([mkEnv({ session_id: "c2", payload: { prompt: "x", cwd: "/r/two" } })]),
    );
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const a = h.store.getSession("c1")!.project_id;
    const b = h.store.getSession("c2")!.project_id;
    expect(a).toBe("p_collide");
    expect(b).toBe("p_collide_1");
    // backfill of id-less rows survives a collision too
    h.store.db.prepare("INSERT INTO projects (project_dir, name) VALUES ('/legacy', 'L')").run();
    expect(h.store.listProjectSummaries(10).find((p) => p.project_dir === "/legacy")!.id).toBe(
      "p_collide_2",
    );
  });
});

describe("backfill reruns", () => {
  it("a store reopened at version 6 heals NULL project_id rows (crash between migration and backfill)", () => {
    const s = Store.open(":memory:");
    s.migrate();
    seedSession(s, "a", { project_dir: "/r/app" });
    s.db.prepare("UPDATE sessions SET project_id = NULL").run();
    expect(s.migrate()).toEqual([]);
    expect(s.getSession("a")!.project_id).toBeTruthy();
    s.close();
  });
});

describe("fix round 2", () => {
  it("PATCH on an archived or long-ended session pushes no WS delta; a live one does", async () => {
    const msgs = await connect();
    seedSession(h.store, "arch", { state: "idle", project_dir: "/r/app" });
    h.store.db.prepare("UPDATE sessions SET state = 'archived' WHERE session_id = 'arch'").run();
    seedSession(h.store, "old", { state: "ended", project_dir: "/r/app" });
    h.store.db
      .prepare("UPDATE sessions SET ended_at = ? WHERE session_id = 'old'")
      .run(NOW - 3_600_000_000);
    seedSession(h.store, "live", { state: "idle", project_dir: "/r/app" });
    const before = deltas(msgs).length;
    expect((await patch("/sessions/arch/phase", { phase: "X" })).statusCode).toBe(200);
    expect((await patch("/sessions/old/phase", { phase: "X" })).statusCode).toBe(200);
    await sleep(100);
    expect(deltas(msgs).length).toBe(before);
    expect((await patch("/sessions/live/phase", { phase: "X" })).statusCode).toBe(200);
    await waitFor(() => deltas(msgs).length === before + 1);
    expect(deltas(msgs).at(-1)!.session_id).toBe("live");
  });

  it("PATCH project with only vault_collection pushes nothing", async () => {
    const msgs = await connect();
    seedSession(h.store, "live", { state: "idle", project_dir: "/r/app" });
    const id = h.store.getSession("live")!.project_id!;
    const before = deltas(msgs).length;
    expect((await patch(`/projects/${id}`, { vault_collection: "ok" })).statusCode).toBe(200);
    await sleep(100);
    expect(deltas(msgs).length).toBe(before);
  });

  it("a throwing atlas listener does not turn a committed PATCH into a 500", async () => {
    seedSession(h.store, "live", { state: "idle", project_dir: "/r/app" });
    h.app.hub.events.on("atlas", () => {
      throw new Error("boom");
    });
    expect((await patch("/sessions/live/phase", { phase: "X" })).statusCode).toBe(200);
  });

  it("vault_collection rejects dots-only and Windows reserved names", async () => {
    seedSession(h.store, "s1", { project_dir: "/r/app" });
    const id = h.store.getSession("s1")!.project_id!;
    for (const v of [".", "...", "CON", "nul", "Com1", "lpt9", "aux.txt", "prn.x.y"]) {
      expect((await patch(`/projects/${id}`, { vault_collection: v })).statusCode).toBe(400);
    }
    for (const v of ["console", "com10", "con-x"]) {
      expect((await patch(`/projects/${id}`, { vault_collection: v })).statusCode).toBe(200);
    }
  });
});
