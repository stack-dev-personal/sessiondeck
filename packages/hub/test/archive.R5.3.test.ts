// R5.2 hub side / R5.3: ingest kind 'archive' and merge with live records.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ArchivePayload, Envelope } from "@sessiondeck/contract";
import { Store } from "../src/db/store.ts";
import { replay } from "../src/replay.ts";
import type { BatchCommitted } from "../src/ingest/ingestor.ts";
import { AUTH, batch, makeHub, type TestHub } from "./support/hub.ts";
import { tempStore } from "./helpers.ts";
import { BASE_TS, FIXTURES, readJson, ulid } from "./support/sequences.ts";

type Golden = Omit<ArchivePayload, "source"> & { source: { root_label: string; rel_path: string } };

function goldens(): Golden[] {
  const out: Golden[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) out.push(JSON.parse(readFileSync(p, "utf8")) as Golden);
    }
  };
  walk(path.join(FIXTURES, "vault/expected"));
  return out.sort((a, b) => a.source.rel_path.localeCompare(b.source.rel_path));
}

const omit = (o: Record<string, unknown>, k: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

let n = 0;
const nextId = (): string => ulid(5_000_000 + ++n);

/** An archive envelope from a golden payload; source.mtime_ms/size are added here. */
function archive(
  g: Golden,
  over: { host?: string; mtime?: number; payload?: Partial<ArchivePayload> } = {},
) {
  n++;
  const payload = {
    ...g,
    source: { ...g.source, mtime_ms: over.mtime ?? BASE_TS, size: 1234 },
    ...over.payload,
  } as ArchivePayload;
  return {
    v: 1,
    id: nextId(),
    kind: "archive",
    host: over.host ?? "h1",
    os: "linux",
    session_id: payload.session_id,
    ts: BASE_TS + n * 10_000,
    seq: 100_000 + n,
    payload,
  } as Envelope;
}

function hook(sessionId: string, fixture: string, ts: number, host = "h1"): Envelope {
  n++;
  const payload = readJson(fixture);
  return {
    v: 1,
    id: nextId(),
    kind: "hook",
    host,
    os: "linux",
    session_id: sessionId,
    hook_event_name: String(payload["hook_event_name"]),
    ts,
    seq: 100_000 + n,
    payload,
  } as Envelope;
}

const A = "a9648976-1965-4d5a-8cf8-eb285b22406f"; // live: start, end
const B = "fc727a7b-bc64-4de4-8767-4a0a61457910"; // live: start, prompt, stop (stays live)
const C = "8cc38311-7274-400a-8426-a201e49b8e4f"; // live: start
const live = (id: string, t0: number): Envelope[] =>
  id === A
    ? [hook(A, "SessionStart/01-startup.json", t0), hook(A, "SessionEnd/01-other.json", t0 + 6000)]
    : id === B
      ? [
          hook(B, "SessionStart/02-compact.json", t0),
          hook(B, "UserPromptSubmit/01-sample.json", t0 + 6000),
          hook(B, "Stop/01-after-ask.json", t0 + 12000),
        ]
      : [hook(C, "SessionStart/03-clear.json", t0)];

const G = goldens();
const g = (id: string): Golden => G.find((x) => x.session_id === id)!;

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});

/** search_dirty is indexing bookkeeping (replay and flush legitimately change it). */
const rows = (store: Store = h.store) =>
  (
    store.db.prepare("SELECT * FROM sessions ORDER BY session_id").all() as Record<
      string,
      unknown
    >[]
  ).map((r) => omit(r, "search_dirty"));
const snap = (id: string) => JSON.parse(h.store.getSession(id)!.snapshot) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = async (envs: Envelope[], host = "h1") => {
  const r = await h.post(batch(envs, host));
  expect(r.statusCode).toBe(200);
  return r.json<{ accepted: number; last_seq: number; rejected?: number }>();
};
const log = { info: () => {}, warn: () => {} };

describe("R5.2 fixture captures", () => {
  it("22 goldens import as 22 archived rows; a second import changes nothing", async () => {
    expect(G).toHaveLength(22);
    expect(new Set(G.map((x) => x.session_id)).size).toBe(22);
    await post(G.map((x) => archive(x)));
    const first = rows();
    expect(first).toHaveLength(22);
    expect(first.every((r) => r["state"] === "archived")).toBe(true);
    h.store.flushSearchIndex();
    const dirtyAfterFlush = h.store.db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE search_dirty = 1")
      .get() as { c: number };
    expect(dirtyAfterFlush.c).toBe(0);

    const upserts = vi.spyOn(h.store, "upsertSession");
    const deltas: BatchCommitted[] = [];
    h.app.hub.events.on("batch", (b) => deltas.push(b));
    // New envelope ids, same payloads (past the 5 s signature window).
    const again = G.map((x) => archive(x));
    await post(again);
    expect(upserts).not.toHaveBeenCalled();
    expect(rows()).toEqual(first);
    expect(deltas.flatMap((d) => d.sessions)).toEqual([]);
    expect(
      (
        h.store.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE search_dirty = 1").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("stores only the parsed payload and never touches the open-session cap", async () => {
    const e = archive(g(A));
    await post([e]);
    const ev = h.store.db.prepare("SELECT payload, kind FROM events WHERE id = ?").get(e.id) as {
      payload: string;
      kind: string;
    };
    expect(ev.kind).toBe("archive");
    expect(JSON.parse(ev.payload)).toEqual(e.payload);
  });
});

describe("validation", () => {
  it("an invalid archive item is rejected alone; the rest of the batch lands", async () => {
    const bad = archive(g(A), { payload: { outcome: "x\u0001y" } });
    const unknownKey = archive(g(B));
    (unknownKey.payload as Record<string, unknown>)["evil"] = "x";
    const mismatch = archive(g(C));
    mismatch.session_id = "someone-else";
    const good = archive(G[3]!);
    const r = await post([bad, unknownKey, mismatch, good]);
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(3);
    expect(r.last_seq).toBe(Math.max(...[bad, unknownKey, mismatch, good].map((e) => e.seq)));
    expect(rows().map((x) => x["session_id"])).toEqual([G[3]!.session_id]);
    expect(h.eventCount()).toBe(1);
    const warns = h.logLines().filter((l) => l["msg"] === "archive envelope rejected");
    expect(warns).toHaveLength(3);
    expect(JSON.stringify(warns)).not.toContain("x\u0001y");
  });

  it("300 archive envelopes do not use open-session slots", async () => {
    const hub2 = await makeHub({ HUB_MAX_OPEN_SESSIONS: "5" });
    try {
      const envs = Array.from({ length: 300 }, (_, i) =>
        archive({ ...G[0]!, session_id: `bulk-${i}`, source: { ...G[0]!.source } }),
      );
      for (let i = 0; i < envs.length; i += 100) {
        expect((await hub2.post(batch(envs.slice(i, i + 100)))).statusCode).toBe(200);
      }
      expect(rows(hub2.store)).toHaveLength(300);
      const starts = Array.from({ length: 5 }, (_, i) =>
        hook(`real-${i}`, "SessionStart/01-startup.json", BASE_TS + 10_000_000 + i * 6000),
      ).map((e, i) => ({ ...e, session_id: `real-${i}` }));
      await hub2.post(batch(starts));
      const real = rows(hub2.store).filter((r) => String(r["session_id"]).startsWith("real-"));
      expect(real).toHaveLength(5);
      expect(hub2.logLines().some((l) => String(l["msg"]).includes("open session cap"))).toBe(
        false,
      );
    } finally {
      await hub2.cleanup();
    }
  });
});

describe("size caps against the 1 MiB ingest limit", () => {
  const maxPayload = (): Partial<ArchivePayload> => ({
    title: "t".repeat(300),
    project_dir: "/" + "d".repeat(1000),
    branch: "b".repeat(255),
    outcome: "o\u00e9\u4e2d".repeat(5461).slice(0, 16384),
    tools_used: Array.from({ length: 100 }, (_, i) => ({
      name: `tool-${i}`.padEnd(100, "x"),
      count: 1,
    })),
    commits: Array.from({ length: 50 }, () => "c".repeat(200)),
    prs: Array.from({ length: 50 }, () => "p".repeat(200)),
  });

  it("a max-size archive batch (14 fit) is accepted under the limit", async () => {
    const envs = Array.from({ length: 14 }, (_, i) =>
      archive(
        { ...G[0]!, session_id: `cap-${i}`, source: { ...G[0]!.source } },
        { payload: { ...maxPayload(), session_id: `cap-${i}` } },
      ),
    );
    const body = batch(envs);
    const size = Buffer.byteLength(JSON.stringify(body));
    expect(size).toBeLessThan(1024 * 1024);
    expect(size).toBeGreaterThan(100_000);
    const r = await h.post(body);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ accepted: number; rejected?: number }>().rejected).toBeUndefined();
    expect(rows()).toHaveLength(14);
  });

  it("an over-cap payload field is rejected alone; an over-1MiB body is refused with 413 and stores nothing", async () => {
    const over = archive(g(A), { payload: { outcome: "x".repeat(16385) } });
    const r1 = await post([over]);
    expect(r1.rejected).toBe(1);
    expect(rows()).toHaveLength(0);
    const envs = Array.from({ length: 60 }, (_, i) =>
      archive(
        { ...G[0]!, session_id: `big-${i}`, source: { ...G[0]!.source } },
        { payload: { ...maxPayload(), session_id: `big-${i}` } },
      ),
    );
    const body = batch(envs);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1024 * 1024);
    const r2 = await h.post(body);
    expect(r2.statusCode).toBe(413);
    expect(rows()).toHaveLength(0);
  });
});

describe("R5.3 merge with live records", () => {
  it.each([[A], [B], [C]])("live first, then archive: one row for %s", async (id) => {
    await post(live(id, BASE_TS + 1_000_000));
    const before = snap(id);
    await post([archive(g(id))]);
    expect(rows()).toHaveLength(1);
    const after = snap(id);
    expect(after["archive"]).toMatchObject({ title: g(id).title, outcome: g(id).outcome });
    const rest = omit(after, "archive");
    expect(rest).toEqual(before); // every live field kept
    const state = h.store.getSession(id)!.state;
    expect(state).toBe(id === A ? "archived" : before["state"]);
  });

  it.each([[A], [B], [C]])("archive first, then live: one row for %s", async (id) => {
    await post([archive(g(id))]);
    expect(h.store.getSession(id)!.state).toBe("archived");
    await post(live(id, BASE_TS + 2_000_000));
    expect(rows()).toHaveLength(1);
    const s = snap(id);
    expect(s["archive"]).toMatchObject({ title: g(id).title });
    expect(s["last_event_at"]).toBeGreaterThan(BASE_TS + 2_000_000 - 1);
    // A ended again -> archived; B and C are live again -> not archived.
    expect(h.store.getSession(id)!.state === "archived").toBe(id === A);
  });

  it("a live session that later exits lands as archived, and a resume keeps the archive", async () => {
    await post(live(B, BASE_TS + 1_000_000));
    await post([archive(g(B))]);
    expect(h.store.getSession(B)!.state).not.toBe("archived");
    await post(
      [hook(B, "SessionEnd/01-other.json", BASE_TS + 1_100_000)].map((e) => ({
        ...e,
        session_id: B,
      })),
    );
    expect(h.store.getSession(B)!.state).toBe("archived");
    await post(
      [hook(B, "SessionStart/01-startup.json", BASE_TS + 1_200_000)].map((e) => ({
        ...e,
        session_id: B,
      })),
    );
    expect(h.store.getSession(B)!.state).not.toBe("archived");
    expect(snap(B)["archive"]).toBeDefined();
    expect(rows()).toHaveLength(1);
  });

  it("attaching to a live session emits a normal delta; an archive-only session emits none", async () => {
    await post(live(B, BASE_TS + 1_000_000));
    const deltas: BatchCommitted[] = [];
    h.app.hub.events.on("batch", (b) => deltas.push(b));
    await post([archive(g(B)), archive(g(C))]);
    const ids = deltas.flatMap((d) => d.sessions.map((s) => s.session_id));
    expect(ids).toEqual([B]);
    expect((deltas[0]!.sessions[0] as unknown as { archive?: unknown }).archive).toBeDefined();
  });

  it("a live session that ends into archived is still pushed once so the board sees it end", async () => {
    await post(live(B, BASE_TS + 1_000_000));
    await post([archive(g(B))]);
    const deltas: BatchCommitted[] = [];
    h.app.hub.events.on("batch", (b) => deltas.push(b));
    await post([hook(B, "SessionEnd/01-other.json", BASE_TS + 1_100_000)]);
    expect(deltas.flatMap((d) => d.sessions.map((s) => s.state))).toEqual(["ended"]);
  });

  it("GET /sessions/:id returns the merged record", async () => {
    await post(live(A, BASE_TS + 1_000_000));
    await post([archive(g(A))]);
    const r = await h.app.inject({ method: "GET", url: `/sessions/${A}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ session_id: A, archive: { title: g(A).title } });
  });
});

describe("host is part of the merge key", () => {
  it("an archive from another host is rejected and attaches nothing", async () => {
    await post(live(B, BASE_TS + 1_000_000));
    const before = rows();
    const bad = archive(g(B), { host: "h2" });
    const r = await post([bad], "h2");
    expect(r.rejected).toBe(1);
    expect(r.accepted).toBe(0);
    expect(rows()).toEqual(before);
    expect(snap(B)["archive"]).toBeUndefined();
    expect(h.store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE id = ?").get(bad.id)).toEqual(
      { c: 0 },
    );
    const w = h.logLines().find((l) => l["reason"] === "archive_host_mismatch")!;
    expect(w["session_id"]).toBe(B);
    expect(Object.keys(w).sort()).toEqual(
      ["envelope_id", "level", "msg", "pid", "hostname", "reason", "session_id", "time"].sort(),
    );
    expect(h.app.hub.archiveRejectedCount()).toBe(1);
  });
});

describe("replacement rules", () => {
  it("a newer mtime with changed content replaces; an older mtime never does", async () => {
    await post([archive(g(A), { mtime: BASE_TS })]);
    await post([
      archive(g(A), { mtime: BASE_TS + 5000, payload: { outcome: "second", title: "Second" } }),
    ]);
    expect(snap(A)["archive"]).toMatchObject({ outcome: "second", title: "Second" });
    expect(snap(A)["session_name"]).toBe("Second"); // still archive-only: synthetic fields follow
    await post([archive(g(A), { mtime: BASE_TS + 1, payload: { outcome: "older" } })]);
    expect(snap(A)["archive"]).toMatchObject({ outcome: "second" });
    expect(rows()).toHaveLength(1);
  });

  it("replacing the archive of a merged session keeps the live fields", async () => {
    await post(live(B, BASE_TS + 1_000_000));
    await post([archive(g(B), { mtime: BASE_TS })]);
    const before = snap(B);
    await post([archive(g(B), { mtime: BASE_TS + 9, payload: { outcome: "newer" } })]);
    const { archive: a, ...rest } = snap(B);
    const was = omit(before, "archive");
    expect(a.outcome).toBe("newer");
    expect(rest).toEqual(was);
  });
});

describe("projects, search, views", () => {
  it("project_dir infers the project; a collection-only capture lands in the collection's project", async () => {
    const withDir = G.find((x) => x.project_dir !== null)!;
    const noDir = G.find(
      (x) => x.project_dir === null && x.collection === "harness/agentic-harness",
    )!;
    await post([archive(withDir), archive(noDir)]);
    const p1 = h.store.getSession(withDir.session_id)!.project_id!;
    const p2 = h.store.getSession(noDir.session_id)!.project_id!;
    expect(h.store.getProject(p2)).toMatchObject({ name: "agentic-harness" });
    expect(p1).toBeTruthy();
    // an existing project with that name wins over creating a new one
    const sibling = G.find(
      (x) =>
        x.project_dir === null &&
        x.session_id !== noDir.session_id &&
        x.collection === noDir.collection,
    )!;
    await post([archive(sibling)]);
    expect(h.store.getSession(sibling.session_id)!.project_id).toBe(p2);
  });

  it("projects.vault_collection link wins", async () => {
    const noDir = G.find((x) => x.project_dir === null)!;
    const pid = h.store.ensureProject("/code/mine", "mine", "#e5484d");
    expect(h.store.patchProject(pid, { vault_collection: noDir.collection })).toBe(true);
    await post([archive(noDir)]);
    expect(h.store.getSession(noDir.session_id)!.project_id).toBe(pid);
  });

  it("project view lists archived entries (newest first) and totals include them; search finds the outcome", async () => {
    const noDir = G.filter(
      (x) => x.project_dir === null && x.collection === "harness/agentic-harness",
    );
    await post(noDir.map((x) => archive(x)));
    const pid = h.store.getSession(noDir[0]!.session_id)!.project_id!;
    const v = (await h.app.inject({ method: "GET", url: `/projects/${pid}`, headers: AUTH })).json<{
      archived: { session_id: string; archive: { title: string } }[];
      live: unknown[];
      totals: { sessions: number; hours: number };
    }>();
    expect(v.live).toEqual([]);
    expect(v.archived).toHaveLength(Math.min(20, noDir.length));
    expect(v.totals.sessions).toBe(noDir.length);
    expect(v.totals.hours).toBeGreaterThan(0);
    const word = "SubagentStop";
    const hit = (
      await h.app.inject({ method: "GET", url: `/search?q=${word}`, headers: AUTH })
    ).json<{
      results: { kind: string; id: string; state: string }[];
    }>();
    expect(hit.results.find((r) => r.id === A)).toMatchObject({
      kind: "session",
      state: "archived",
    });
  });

  it("hostile search input is quoted, not interpreted", async () => {
    await post([archive(g(A))]);
    for (const q of ['"', "a OR b", "NEAR(", "title:x*", '") OR ("', "-x", "^a"]) {
      const r = await h.app.inject({
        method: "GET",
        url: `/search?q=${encodeURIComponent(q)}`,
        headers: AUTH,
      });
      expect(r.statusCode).toBe(200);
    }
  });
});

describe("replay and restart", () => {
  it("replay of the stored events reproduces the same rows", async () => {
    await post(G.map((x) => archive(x)));
    await post(live(A, BASE_TS + 1_000_000));
    await post(live(B, BASE_TS + 1_000_000));
    await post([
      archive(g(B)),
      archive(g(A), { mtime: BASE_TS + 77, payload: { title: "Edited" } }),
    ]);
    await post(live(C, BASE_TS + 3_000_000));
    await post([archive(g(C), { mtime: BASE_TS - 5 })]); // stale
    const before = rows();
    expect(before).toHaveLength(22);
    const res = replay(h.store, log, { maxOpenSessionsPerHost: 1000 });
    expect(res.exceptions).toBe(0);
    expect(rows()).toEqual(before);
  });

  it("replay skips a stored archive event that fails validation, without taking a slot", () => {
    const { store, cleanup } = tempStore();
    try {
      store.migrate();
      store.db
        .prepare(
          "INSERT INTO events (id, host, seq, kind, session_id, ts, payload) VALUES (?, 'h1', 1, 'archive', 'x', ?, ?)",
        )
        .run(nextId(), BASE_TS, JSON.stringify({ junk: true }));
      const warns: string[] = [];
      const r = replay(
        store,
        { info: () => {}, warn: (_o, m) => void warns.push(m) },
        { maxOpenSessionsPerHost: 1 },
      );
      expect(r.exceptions).toBe(0);
      expect(rows(store)).toHaveLength(0);
      expect(warns).toContain("stored archive event skipped");
    } finally {
      cleanup();
    }
  });

  it("archive data survives a restart", async () => {
    const { store, cleanup } = tempStore({ file: true });
    try {
      store.migrate();
      const { Ingestor } = await import("../src/ingest/ingestor.ts");
      new Ingestor(store, log).ingest("h1", [archive(g(A))]);
      const file = store.db.name;
      store.close();
      const again = Store.open(file);
      again.migrate();
      expect(
        (JSON.parse(again.getSession(A)!.snapshot) as { archive: { outcome: string } }).archive
          .outcome,
      ).toBe(g(A).outcome);
      expect(again.getSession(A)!.state).toBe("archived");
      again.close();
    } finally {
      cleanup();
    }
  });
});

describe("timing", () => {
  it("293 archive envelopes in batches of 200 ingest well under 10 s", async () => {
    const envs = Array.from({ length: 293 }, (_, i) => {
      const base = G[i % G.length]!;
      return archive({ ...base, session_id: `t-${i}`, source: { ...base.source } });
    });
    const t0 = performance.now();
    for (let i = 0; i < envs.length; i += 200) await post(envs.slice(i, i + 200));
    const ms = performance.now() - t0;
    console.log(`archive ingest: 293 envelopes in ${ms.toFixed(1)} ms`);
    expect(rows()).toHaveLength(293);
    expect(ms).toBeLessThan(10_000);
  });
});
