import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rowOf } from "../src/ingest/ingestor.ts";
import { buildMatch } from "../src/atlas/search.ts";
import { AUTH, makeHub, seedSession, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});
interface Hit {
  kind: string;
  id: string;
  project_id: string | null;
  title: string;
  snippet: string;
  state?: string;
  score: number;
}
const search = async (q: string, extra = "") => {
  const r = await h.app.inject({
    method: "GET",
    url: `/search?q=${encodeURIComponent(q)}${extra}`,
    headers: AUTH,
  });
  return { status: r.statusCode, body: r.json() as { results: Hit[]; took_ms: number } };
};
const patch = (url: string, payload: unknown) =>
  h.app.inject({ method: "PATCH", url, headers: AUTH, payload: payload as object });

function seed() {
  seedSession(h.store, "s-name", {
    session_name: "Refactor billing pipeline",
    project_dir: "/r/payments",
  });
  seedSession(h.store, "s-prompt", {
    last_prompt: "please investigate the flaky websocket reconnect",
    project_dir: "/r/payments",
  });
  seedSession(h.store, "s-msg", {
    last_assistant_message: "I rewrote the tokenizer and added regression coverage",
    project_dir: "/r/other",
  });
  seedSession(h.store, "s-out", {
    state: "archived",
    outcome: "harness capture passed: zebra scenario",
    project_dir: "/r/other",
  } as never);
}

describe("R5.4 search", () => {
  it("returns the right kind for name, prompt, message, outcome, project and phase queries", async () => {
    seed();
    expect((await search("billing")).body.results[0]).toMatchObject({
      kind: "session",
      id: "s-name",
    });
    expect((await search("websocket")).body.results[0]).toMatchObject({ id: "s-prompt" });
    expect((await search("tokeniz")).body.results[0]).toMatchObject({ id: "s-msg" });
    expect((await search("zebra")).body.results[0]).toMatchObject({
      id: "s-out",
      state: "archived",
    });
    const proj = (await search("payments")).body.results.find((x) => x.kind === "project");
    expect(proj).toMatchObject({ title: "payments" });
    await patch("/sessions/s-name/phase", { phase: "Hardening" });
    const ph = (await search("hardening")).body.results;
    expect(ph.map((x) => x.kind).sort()).toEqual(["phase", "session"]);
    expect(ph.find((x) => x.kind === "phase")).toMatchObject({
      id: "Hardening",
      project_id: h.store.getSession("s-name")!.project_id,
    });
    expect((await search("nomatchatall")).body.results).toEqual([]);
  });

  it("indexes inferred phases and diacritics-insensitively", async () => {
    seedSession(h.store, "s1", { session_name: "P5 café atlas", project_dir: "/r/app" });
    expect((await search("p5")).body.results.map((x) => x.kind).sort()).toEqual([
      "phase",
      "session",
    ]);
    expect((await search("caf")).body.results[0]).toMatchObject({ id: "s1" });
  });

  it("follows project rename, vault_collection and phase edits, and drops unused phases", async () => {
    seedSession(h.store, "s1", { session_name: "alpha", project_dir: "/r/app" });
    const pid = h.store.getSession("s1")!.project_id!;
    expect((await search("gadgets")).body.results).toEqual([]);
    expect((await patch(`/projects/${pid}`, { name: "Gadgets Hub" })).statusCode).toBe(200);
    expect((await search("gadgets")).body.results[0]).toMatchObject({ kind: "project", id: pid });
    expect((await search("app")).body.results[0]).toMatchObject({ kind: "project" }); // dir basename
    await patch(`/projects/${pid}`, { vault_collection: "notes-vault" });
    expect((await search("notes")).body.results[0]).toMatchObject({ id: pid });
    await patch("/sessions/s1/phase", { phase: "Launch" });
    expect((await search("launch")).body.results.some((x) => x.kind === "phase")).toBe(true);
    await patch("/sessions/s1/phase", { phase: "Cooldown" });
    const after = (await search("launch")).body.results;
    expect(after).toEqual([]);
    expect((await search("cooldown")).body.results.some((x) => x.kind === "phase")).toBe(true);
    await patch("/sessions/s1/phase", { phase: null });
    expect((await search("cooldown")).body.results).toEqual([]);
  });

  it("re-indexes a session when its text changes and not when it does not", async () => {
    const snap = seedSession(h.store, "s1", { last_prompt: "first banana" });
    expect((await search("banana")).body.results.length).toBe(1);
    const count = () =>
      (h.store.db.prepare("SELECT COUNT(*) AS n FROM search_fts").get() as { n: number }).n;
    const before = count();
    seedSession(h.store, "s1", { last_prompt: "first banana", last_event_at: snap.last_event_at });
    expect(count()).toBe(before);
    seedSession(h.store, "s1", { last_prompt: "second cherry" });
    expect((await search("banana")).body.results).toEqual([]);
    expect((await search("cherry")).body.results[0]).toMatchObject({ id: "s1" });
    expect(count()).toBe(before);
  });

  it("moving a session to another project moves the project_id of its hit", async () => {
    seedSession(h.store, "s1", { last_prompt: "mango", project_dir: "/r/one" });
    seedSession(h.store, "s2", { project_dir: "/r/two" });
    const p2 = h.store.getSession("s2")!.project_id!;
    await patch("/sessions/s1/project", { project_id: p2 });
    expect((await search("mango")).body.results[0]).toMatchObject({ project_id: p2 });
  });

  it("drops the old inferred phase document when ingest renames the phase", async () => {
    seedSession(h.store, "s1", { session_name: "P4 foo", project_dir: "/r/a" });
    expect((await search("p4")).body.results.some((x) => x.kind === "phase")).toBe(true);
    seedSession(h.store, "s1", { session_name: "P5 foo", project_dir: "/r/a" });
    expect((await search("p4")).body.results.filter((x) => x.kind === "phase")).toEqual([]);
    expect((await search("p5")).body.results.filter((x) => x.kind === "phase").length).toBe(1);
  });

  it("moves the inferred phase document with a session whose project_dir changes on ingest", async () => {
    seedSession(h.store, "s1", { session_name: "P5 foo", project_dir: "/r/a" });
    seedSession(h.store, "s1", { session_name: "P5 foo", project_dir: "/r/b" });
    const phases = (await search("p5")).body.results.filter((x) => x.kind === "phase");
    expect(phases.length).toBe(1);
    expect(phases[0]!.project_id).toBe(h.store.getSession("s1")!.project_id);
  });

  it("skips all index work for a byte-identical snapshot", async () => {
    const snap = seedSession(h.store, "s1", { last_prompt: "kiwi" });
    const spy = vi.spyOn(JSON, "parse");
    try {
      h.store.upsertSession(rowOf(snap));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a one-character query returns recent items, not a prefix scan", async () => {
    seed();
    const r = await search("t");
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBeGreaterThan(0); // recent items
    expect(r.body.results.map((x) => x.id)).toEqual(
      h.store.searchRecent(r.body.results.length).map((x) => x.id),
    );
    expect(r.body.results.every((x) => x.snippet.length <= 120)).toBe(true);
  });

  it("indexing is off the write path: upsert writes no document, the timer flushes within a second", async () => {
    const snap = seedSession(h.store, "s-lazy", { last_prompt: "quokka" });
    const count = () =>
      (
        h.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM search_docs WHERE kind = 'session' AND ref_id = 's-lazy'",
          )
          .get() as { n: number }
      ).n;
    expect(snap).toBeDefined();
    expect(count()).toBe(0);
    await new Promise((r) => setTimeout(r, 600));
    expect(count()).toBe(1);
  });

  it("coalesces: many updates of one session between flushes index it once", async () => {
    for (let i = 0; i < 20; i++) seedSession(h.store, "s-co", { last_prompt: `quokka ${i}` });
    h.store.flushSearchIndex();
    expect((await search("quokka")).body.results.filter((x) => x.id === "s-co").length).toBe(1);
    expect((await search("19")).body.results[0]).toMatchObject({ id: "s-co" });
  });

  it("backfills an existing database on open", async () => {
    seed();
    h.store.flushSearchIndex();
    h.store.db.exec("DELETE FROM search_fts; DELETE FROM search_docs;");
    expect((await search("billing")).body.results).toEqual([]);
    expect(h.store.backfillSearch()).toBeGreaterThan(0);
    expect((await search("billing")).body.results[0]).toMatchObject({ id: "s-name" });
  });

  it("replay rebuild (deleteAllSessions + re-upsert) leaves the index correct", async () => {
    seed();
    const rows = ["s-name", "s-prompt"].map((id) => h.store.getSession(id)!);
    h.store.transaction(() => {
      h.store.deleteAllSessions();
      for (const r of rows) h.store.upsertSession(r);
    });
    expect((await search("billing")).body.results[0]).toMatchObject({ id: "s-name" });
    expect((await search("tokeniz")).body.results).toEqual([]);
  });

  it("ranks a live session above an ended one with the same text", async () => {
    seedSession(h.store, "ended", { last_prompt: "needle", state: "ended" });
    seedSession(h.store, "live", { last_prompt: "needle", state: "working" });
    const r = (await search("needle")).body.results;
    expect(r.map((x) => x.id)).toEqual(["live", "ended"]);
  });

  it("empty q returns recent sessions then projects; limit is bounded", async () => {
    seed();
    const r = await search("");
    expect(r.status).toBe(200);
    expect(r.body.results.some((x) => x.kind === "session")).toBe(true);
    expect(r.body.results.some((x) => x.kind === "project")).toBe(true);
    expect((await search("", "&limit=2")).body.results.length).toBe(2);
    for (const bad of ["&limit=0", "&limit=51", "&limit=x"]) {
      expect((await search("a", bad)).status).toBe(400);
    }
    expect((await search("x".repeat(201))).status).toBe(400);
    expect((await search("x".repeat(200))).status).toBe(200);
  });

  it("a malformed percent-escape does not throw", async () => {
    const r = await h.app.inject({ method: "GET", url: "/search?q=%ED%A0%80%ff", headers: AUTH });
    expect(r.statusCode).toBe(200);
  });

  it("requires the bearer token", async () => {
    const r = await h.app.inject({ method: "GET", url: "/search?q=a" });
    expect(r.statusCode).toBe(401);
    expect(r.body).toBe("");
  });

  it.each([
    '"',
    '""',
    '"unterminated',
    "a AND",
    "NEAR(a b)",
    "NEAR/2",
    "title:billing",
    "{title body}:x",
    "(",
    ")",
    "((a)",
    "*",
    "**",
    "a*",
    "^a",
    "-a",
    "a OR b NOT c",
    "a + b",
    "\\",
    "'; DROP TABLE sessions;--",
    "\u0000",
    "billing\u0000",
    "😀",
    "body: *",
    'col:"x"',
  ])("hostile query %j does not throw", async (q) => {
    seed();
    const r = await search(q);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 4 });
  });

  it("treats operators as plain words", async () => {
    seed();
    expect(buildMatch("NEAR(a b) title:x*")).toBe('"NEAR" "a" "b" "title"*');
    expect(buildMatch("fix te")).toBe('"fix" "te"*');
    expect(buildMatch("t")).toBeNull();
    expect(buildMatch("fix t")).toBe('"fix"*'); // a trailing single character is dropped, not matched exactly
    expect(buildMatch("*")).toBeNull();
    expect((await search("billing NEAR")).body.results).toEqual([]); // NEAR is a required word
    expect((await search("title:billing")).body.results).toEqual([]); // "title" is a word, not a filter
  });
});
