import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Envelope } from "@sessiondeck/contract";
import { Store } from "../src/db/store.ts";
import { runCli } from "../src/cli.ts";
import { Ingestor, type Logger } from "../src/ingest/ingestor.ts";
import { replay } from "../src/replay.ts";
import {
  DAY_MS,
  compactEvents,
  pruneSamples,
  runRetention,
  startRetentionTimer,
} from "../src/retention.ts";
import { mkEnv } from "./support/hub.ts";
import { SEQUENCES, readJson, type Seq } from "./support/sequences.ts";
import { tempStore } from "./helpers.ts";

const OPEN = 1000;

function capture(): Logger & {
  lines: { level: string; obj: Record<string, unknown>; msg: string }[];
} {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    lines,
    info: (obj, msg) =>
      void lines.push({ level: "info", obj: obj as Record<string, unknown>, msg }),
    warn: (obj, msg) =>
      void lines.push({ level: "warn", obj: obj as Record<string, unknown>, msg }),
  };
}

function derived(store: Store): { sessions: unknown[]; samples: unknown[]; lines: unknown[] } {
  const all = (sql: string): unknown[] => store.db.prepare(sql).all();
  return {
    sessions: all("SELECT * FROM sessions ORDER BY session_id"),
    samples: all("SELECT * FROM statusline_samples ORDER BY session_id, ts"),
    lines: all("SELECT rowid, * FROM transcript_lines ORDER BY rowid"),
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * Ingests through the Ingestor in batches of `size`, the code path POST /ingest runs. The HTTP
 * layer (auth, validation, limits) is covered by the ingest tests and is not what replay is
 * compared to. Each (sequence, batch size) is ingested once per worker and kept as a serialized
 * database image; every call returns its own private in-memory copy, so tests may mutate freely
 * (R0.5 budget: the same five sequences were ingested 15 times).
 */
const images = new Map<string, Buffer>();
function ingested(seq: Seq, size = 40): { store: Store } {
  const key = `${seq.name}:${size}`;
  let image = images.get(key);
  if (!image) {
    const t = tempStore();
    t.store.migrate();
    const ing = new Ingestor(t.store, capture());
    for (let i = 0; i < seq.envelopes.length; i += size) {
      ing.ingest(seq.host, seq.envelopes.slice(i, i + size));
    }
    expect(t.store.countEvents()).toBe(seq.envelopes.length);
    image = t.store.db.serialize();
    // Works only because tempStore() is in-memory: serialize() of a WAL file database keeps
    // header bytes 18/19 = 2 and `new Database(image)` then fails with SQLITE_CANTOPEN.
    expect(image[18]).toBe(1);
    t.cleanup();
    images.set(key, image);
  }
  const db = new Database(image);
  db.pragma("foreign_keys = ON");
  // Store's constructor is private to keep production callers on Store.open.
  const store = new (Store as unknown as new (d: Database.Database) => Store)(db);
  cleanups.push(() => store.close());
  return { store };
}

describe("R2.9 replay", () => {
  for (const make of SEQUENCES) {
    const seq = make();
    it(`${seq.name}: replay equals the ingest-time rows exactly, with 0 reducer exceptions`, async () => {
      const h = ingested(seq);
      const before = derived(h.store);
      const log = capture();
      const r = replay(h.store, log, { maxOpenSessionsPerHost: OPEN });
      expect(r.exceptions).toBe(0);
      expect(log.lines.filter((l) => l.msg === "reducer exception")).toEqual([]);
      expect(r.events).toBe(seq.envelopes.length);
      expect(r.sessions).toBe(before.sessions.length);
      expect(derived(h.store)).toEqual(before);
    });
  }

  it("repairs corrupted snapshots (recovery) and equals the golden file", async () => {
    const seq = SEQUENCES[0]!();
    const h = ingested(seq);
    const good = derived(h.store);
    h.store.db.prepare("UPDATE sessions SET snapshot = '{\"bad\":true}', state = 'x'").run();
    replay(h.store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(h.store)).toEqual(good);
  });

  it("is atomic: an error mid-replay leaves the old snapshots", async () => {
    const seq = SEQUENCES[0]!();
    const h = ingested(seq);
    h.store.db.prepare("UPDATE sessions SET snapshot = '{\"old\":true}'").run();
    const old = derived(h.store);
    expect(() =>
      replay(h.store, capture(), {
        maxOpenSessionsPerHost: OPEN,
        onProgress: () => {
          throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    expect(derived(h.store)).toEqual(old);
  });

  it("is safe against a hub on the same file: its writes wait (BUSY), reads see the old state, nothing is lost", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hub-replay-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.sqlite");
    const a = Store.open(file);
    a.migrate();
    const ing = new Ingestor(a, capture());
    const seq = SEQUENCES[0]!();
    ing.ingest(seq.host, seq.envelopes);
    const live = Store.open(file);
    live.db.pragma("busy_timeout = 50");
    const before = derived(a);
    let blocked: unknown;
    let readDuring: unknown;
    replay(a, capture(), {
      maxOpenSessionsPerHost: OPEN,
      onProgress: () => {
        readDuring = live.db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
        try {
          new Ingestor(live, capture()).ingest("h9", [mkEnv({ host: "h9", session_id: "late" })]);
        } catch (e) {
          blocked = e;
        }
      },
    });
    expect((blocked as { code?: string }).code).toBe("SQLITE_BUSY");
    expect((readDuring as { n: number }).n).toBe(before.sessions.length);
    expect(derived(a)).toEqual(before);
    // After the commit the live writer proceeds.
    const r = new Ingestor(live, capture()).ingest("h9", [
      mkEnv({ host: "h9", session_id: "late" }),
    ]);
    expect(r.accepted).toBe(1);
    expect(live.getSession("late")).toBeDefined();
    a.close();
    live.close();
  });
});

/** Hook envelopes for one session, one per minute starting at t0. */
function session(sid: string, host: string, t0: number, n: number, seq0: number): Envelope[] {
  return Array.from({ length: n }, (_, i) =>
    mkEnv({
      host,
      session_id: sid,
      seq: seq0 + i,
      ts: t0 + i * 60_000,
      hook_event_name: i === 0 ? "SessionStart" : "UserPromptSubmit",
      payload:
        i === 0
          ? { ...readJson("SessionStart/01-startup.json"), session_id: sid }
          : {
              prompt: `${sid}-${i}`,
              cwd: "/w",
              session_id: sid,
              hook_event_name: "UserPromptSubmit",
            },
    }),
  );
}

describe("R2.9 event compaction", () => {
  const NOW = 1_800_000_000_000;
  const DAYS = 30;
  const cut = NOW - DAYS * DAY_MS;

  function setup(): { store: Store; ing: Ingestor; envs: Envelope[] } {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.migrate();
    const ing = new Ingestor(t.store, capture());
    // A: all old. B: spans the cut. C: all recent. Interleaved by ts across two hosts.
    const envs = [
      ...session("A", "h1", cut - 3 * DAY_MS, 10, 1),
      ...session("B", "h1", cut - 5 * 60_000, 10, 100),
      ...session("C", "h2", cut + DAY_MS, 10, 1),
    ].sort((x, y) => x.ts - y.ts);
    for (let i = 0; i < envs.length; i += 4) {
      const chunk = envs.slice(i, i + 4);
      ing.ingest(
        chunk[0]!.host,
        chunk.filter((e) => e.host === chunk[0]!.host),
      );
      const rest = chunk.filter((e) => e.host !== chunk[0]!.host);
      if (rest.length > 0) ing.ingest(rest[0]!.host, rest);
    }
    return { store: t.store, ing, envs };
  }

  it("replay after compaction equals the snapshots before it (all-compacted, spanning, untouched)", async () => {
    const { store } = setup();
    const before = derived(store);
    const total = store.countEvents();
    const r = await compactEvents(store, capture(), {
      maxTs: Infinity,
      cutoffMs: cut,
      maxOpenSessionsPerHost: OPEN,
      batchSize: 3,
    });
    expect(r.events).toBeGreaterThan(10);
    expect(r.batches).toBeGreaterThan(3);
    expect(store.countEvents()).toBe(total - r.events);
    expect(store.getCompactionCut()).toBe(cut);
    // Nothing visible changed.
    expect(derived(store)).toEqual(before);
    const ids = store
      .listBaselines()
      .map((b) => b.session_id)
      .sort();
    expect(ids).toContain("A");
    expect(ids).toContain("B");
    // A has no events left; B has some; C all.
    const left = (sid: string): number =>
      (
        store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(sid) as {
          n: number;
        }
      ).n;
    expect(left("A")).toBe(0);
    expect(left("B")).toBeGreaterThan(0);
    expect(left("B")).toBeLessThan(10);
    expect(left("C")).toBe(10);
    const rr = replay(store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(rr.exceptions).toBe(0);
    expect(derived(store)).toEqual(before);
    // Idempotent.
    const again = await compactEvents(store, capture(), {
      maxTs: Infinity,
      cutoffMs: cut,
      maxOpenSessionsPerHost: OPEN,
    });
    expect(again.events).toBe(0);
  });

  it("compacting in several passes with a rising cutoff equals one pass and ingest", async () => {
    const { store } = setup();
    const before = derived(store);
    for (const c of [cut - 2 * DAY_MS, cut, cut + 2 * DAY_MS]) {
      await compactEvents(store, capture(), {
        maxTs: Infinity,
        cutoffMs: c,
        maxOpenSessionsPerHost: OPEN,
        batchSize: 5,
      });
      replay(store, capture(), { maxOpenSessionsPerHost: OPEN });
      expect(derived(store)).toEqual(before);
    }
    expect(store.countEvents()).toBeLessThan(5);
  });

  it("all events compacted: replay rebuilds from baselines alone", async () => {
    const { store } = setup();
    const before = derived(store);
    await compactEvents(store, capture(), {
      maxTs: Infinity,
      cutoffMs: NOW,
      maxOpenSessionsPerHost: OPEN,
    });
    expect(store.countEvents()).toBe(0);
    replay(store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(store)).toEqual(before);
  });

  it("stops at the first retained event: a late old event behind it is not compacted out of order", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.migrate();
    const ing = new Ingestor(t.store, capture());
    const [a, b, c] = session("X", "h1", cut - 1000, 3, 1) as [Envelope, Envelope, Envelope];
    const recent = { ...b, ts: cut + 60_000 };
    ing.ingest("h1", [a, recent, { ...c, ts: cut - 500 }]);
    const before = derived(t.store);
    const r = await compactEvents(t.store, capture(), {
      maxTs: Infinity,
      cutoffMs: cut,
      maxOpenSessionsPerHost: OPEN,
    });
    expect(r.events).toBe(1);
    replay(t.store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(t.store)).toEqual(before);
  });

  it("dedup still works at the cut: signature window against retained events, watermark against compacted ones", async () => {
    const { store, ing, envs } = setup();
    await compactEvents(store, capture(), {
      maxTs: Infinity,
      cutoffMs: cut,
      maxOpenSessionsPerHost: OPEN,
    });
    const retained = store.listEventsAfterRowid(0, 1)[0]!;
    const orig = envs.find((e) => e.id === retained.id)!;
    // Same content 1 s later, new id and seq: a signature duplicate of a retained event.
    const dupSig = { ...orig, id: mkEnv().id, seq: 9999, ts: orig.ts + 1000 };
    // Same content just below the cut, relative to a retained event within 5 s: older than the watermark.
    const old = { ...orig, id: mkEnv().id, seq: 9998, ts: cut - 1 };
    // Resend of a compacted envelope by id.
    const compacted = envs.find((e) => e.ts < cut)!;
    const fresh = mkEnv({
      host: orig.host,
      session_id: orig.session_id,
      ts: cut + 2 * DAY_MS,
      seq: 10_000,
    });
    const r = ing.ingest(orig.host, [dupSig, old, compacted, fresh]);
    expect(r).toMatchObject({ accepted: 1, duplicates: 1, expired: 2 });
  });

  it("does not delete transcript_lines or move their rowids (usage index high-water mark)", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.migrate();
    const ing = new Ingestor(t.store, capture());
    const tr = mkEnv({
      host: "h1",
      kind: "transcript",
      hook_event_name: undefined,
      session_id: "T",
      ts: cut - DAY_MS,
      payload: { start_line: 0, lines: ['{"a":1}', '{"a":2}'] },
    });
    delete (tr as { hook_event_name?: string }).hook_event_name;
    ing.ingest("h1", [tr]);
    const lines = () =>
      t.store.db.prepare("SELECT rowid, * FROM transcript_lines ORDER BY rowid").all();
    const before = lines();
    expect(before).toHaveLength(2);
    const r = await compactEvents(t.store, capture(), {
      maxTs: Infinity,
      cutoffMs: cut,
      maxOpenSessionsPerHost: OPEN,
    });
    expect(r.events).toBe(1);
    expect(lines()).toEqual(before);
  });
});

describe("R2.9 statusline sample retention and scheduling", () => {
  it("prunes samples older than the window in bounded batches", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.migrate();
    const now = 1_800_000_000_000;
    for (let i = 0; i < 25; i++) {
      t.store.upsertSample({
        session_id: i % 2 === 0 ? "a" : "b",
        ts: now - i * DAY_MS,
        context_used_pct: 1,
        cost_usd: 1,
        five_hour_pct: null,
        five_hour_resets: null,
        seven_day_pct: null,
        seven_day_resets: null,
      });
    }
    const log = capture();
    const r = await pruneSamples(t.store, log, {
      maxTs: Infinity,
      cutoffMs: now - 10 * DAY_MS + 1,
      batchSize: 4,
    });
    expect(r.samples).toBe(15); // i = 10..24
    const left = (
      t.store.db.prepare("SELECT COUNT(*) AS n FROM statusline_samples").get() as { n: number }
    ).n;
    expect(left).toBe(10);
    expect(log.lines.at(-1)).toMatchObject({ msg: "sample retention", obj: { samples: 15 } });
  });

  it("runRetention applies both windows and logs counts", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.migrate();
    const now = 1_800_000_000_000;
    new Ingestor(t.store, capture()).ingest("h1", session("S", "h1", now - 60 * DAY_MS, 5, 1));
    const log = capture();
    const r = await runRetention(
      t.store,
      log,
      { eventRetentionDays: 30, sampleRetentionDays: 30, maxOpenSessionsPerHost: OPEN },
      now,
    );
    expect(r.compact.events).toBe(5);
    expect(log.lines.map((l) => l.msg)).toEqual(["event compaction", "sample retention"]);
  });

  it("the timer compacts on its own, interval 0 disables it, stop() ends it", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.migrate();
    new Ingestor(t.store, capture()).ingest(
      "h1",
      session("S", "h1", Date.now() - 90 * DAY_MS, 5, 1),
    );
    const cfg = { eventRetentionDays: 30, sampleRetentionDays: 30, maxOpenSessionsPerHost: OPEN };
    const off = startRetentionTimer(t.store, capture(), { ...cfg, intervalMs: 0 });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.store.countEvents()).toBe(5);
    off.stop();
    const on = startRetentionTimer(t.store, capture(), {
      ...cfg,
      intervalMs: 30,
      initialDelayMs: 1,
    });
    for (let i = 0; i < 100 && t.store.countEvents() > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    on.stop();
    expect(t.store.countEvents()).toBe(0);
    expect(t.store.listBaselines()).toHaveLength(1);
  });
});

describe("R2.9 cli", () => {
  it("replay prints sessions, events, elapsed and exceptions; compact prints counts; usage errors exit 2", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hub-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.sqlite");
    const s = Store.open(file);
    s.migrate();
    // The CLI output is under test, not the volume: a prefix keeps the file I/O small.
    const seq = SEQUENCES[0]!();
    const envelopes = seq.envelopes.slice(0, 40);
    new Ingestor(s, capture()).ingest(seq.host, envelopes);
    s.close();
    const out: string[] = [];
    const log = capture();
    expect(await runCli(["replay", "--db", file], {}, (l) => out.push(l), log)).toBe(0);
    expect(out[0]).toMatch(
      new RegExp(
        `^replay: sessions=\\d+ events=${envelopes.length} samples=\\d+ elapsed_ms=\\d+ reducer_exceptions=0$`,
      ),
    );
    out.length = 0;
    expect(
      await runCli(
        ["compact"],
        { HUB_DB_PATH: file, HUB_EVENT_RETENTION_DAYS: "1" },
        (l) => out.push(l),
        log,
      ),
    ).toBe(0);
    expect(out[0]).toMatch(/^compact: events=\d+ /);
    expect(await runCli(["bogus"], {}, (l) => out.push(l), log)).toBe(2);
    expect(
      await runCli(
        ["replay", "--db", path.join(dir, "missing.sqlite")],
        {},
        (l) => out.push(l),
        log,
      ),
    ).toBe(2);
    expect(await runCli(["replay", "--wat"], {}, (l) => out.push(l), log)).toBe(2);
  });
});

describe("R2.9 compaction over the Phase 0 fixture sequences", () => {
  for (const make of SEQUENCES) {
    const seq = make();
    for (const frac of [0.3, 0.7, 2]) {
      it(`${seq.name}: cut at ${frac < 1 ? `${frac * 100}%` : "end"} then replay equals ingest`, async () => {
        const t = ingested(seq, seq.envelopes.length);
        const before = derived(t.store);
        const idx = Math.min(seq.envelopes.length - 1, Math.floor(seq.envelopes.length * frac));
        const cutoffMs = frac >= 1 ? Number.MAX_SAFE_INTEGER : seq.envelopes[idx]!.ts;
        const c = await compactEvents(t.store, capture(), {
          maxTs: Infinity,
          cutoffMs,
          maxOpenSessionsPerHost: OPEN,
          batchSize: 7,
        });
        expect(c.exceptions).toBe(0);
        const r = replay(t.store, capture(), { maxOpenSessionsPerHost: OPEN });
        expect(r.exceptions).toBe(0);
        expect(derived(t.store)).toEqual(before);
      });
    }
  }
});
