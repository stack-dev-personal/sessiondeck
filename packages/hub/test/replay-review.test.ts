// Review-round tests for R2.9: clock-skew bound (K1), expired envelopes (K2), concurrent
// compactors and the lease (K3), batch budget (K4), replay sample window (K6), open-session cap
// parity (K7), baseline-qualified SQL (K8) and the --db guard (K9).
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { runCli } from "../src/cli.ts";
import { Ingestor, type Logger } from "../src/ingest/ingestor.ts";
import { leaseRemainingMs, startLease } from "../src/lease.ts";
import { replay } from "../src/replay.ts";
import { DAY_MS, compactEvents, pruneSamples, runRetention } from "../src/retention.ts";
import { batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";
import { SEQUENCES, readJson } from "./support/sequences.ts";
import { tempStore } from "./helpers.ts";

const OPEN = 1000;
const NOW = 1_800_000_000_000;
const CUT = NOW - 30 * DAY_MS;
const MAXTS = NOW + DAY_MS;

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

function session(
  sid: string,
  host: string,
  t0: number,
  n: number,
  seq0: number,
  end = false,
): Envelope[] {
  return Array.from({ length: n }, (_, i) => {
    const last = end && i === n - 1;
    return mkEnv({
      host,
      session_id: sid,
      seq: seq0 + i,
      ts: t0 + i * 60_000,
      hook_event_name: i === 0 ? "SessionStart" : last ? "SessionEnd" : "UserPromptSubmit",
      payload:
        i === 0
          ? { ...readJson("SessionStart/01-startup.json"), session_id: sid }
          : last
            ? { ...readJson("SessionEnd/01-other.json"), session_id: sid }
            : {
                prompt: `${sid}-${i}`,
                cwd: "/w",
                session_id: sid,
                hook_event_name: "UserPromptSubmit",
              },
    });
  });
}

let hub: TestHub | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
  for (const c of cleanups.splice(0)) c();
});

function mem(): { store: Store; ing: Ingestor; log: ReturnType<typeof capture> } {
  const t = tempStore();
  cleanups.push(t.cleanup);
  t.store.migrate();
  const log = capture();
  return { store: t.store, ing: new Ingestor(t.store, log), log };
}

function file(): { path: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hub-rv-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { path: path.join(dir, "hub.sqlite"), dir };
}

describe("K1 clock skew bound", () => {
  it("HUB_MAX_CLOCK_SKEW_MS must be 60000 ms .. 7 days", () => {
    const t = { HUB_TOKEN: "a".repeat(16) };
    for (const v of ["59999", "604800001", "0", "x"]) {
      expect(() => loadConfig({ ...t, HUB_MAX_CLOCK_SKEW_MS: v }), v).toThrow(/CLOCK_SKEW/);
    }
    expect(loadConfig({ ...t, HUB_MAX_CLOCK_SKEW_MS: "60000" }).maxClockSkewMs).toBe(60000);
    expect(loadConfig({ ...t, HUB_MAX_CLOCK_SKEW_MS: "604800000" }).maxClockSkewMs).toBe(604800000);
  });

  it("ingest refuses an envelope more than HUB_MAX_CLOCK_SKEW_MS ahead of the hub clock (400, reason, nothing stored)", async () => {
    hub = await makeHub({ HUB_MAX_CLOCK_SKEW_MS: "60000" }, undefined, { wallClock: () => NOW });
    const ok = mkEnv({ ts: NOW + 59_000, seq: 1 });
    const far = mkEnv({ ts: 9e15, seq: 2 });
    const res = await hub.post(batch([ok, far]));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_envelope",
      reason: "envelopes[1].ts: too_far_in_future",
    });
    expect(hub.eventCount()).toBe(0);
    expect((await hub.post(batch([ok]))).statusCode).toBe(200);
  });

  it("logs a far-future rejection with host, index and count only", async () => {
    hub = await makeHub({}, undefined, { wallClock: () => NOW });
    await hub.post(batch([mkEnv({ ts: NOW, seq: 1 }), mkEnv({ ts: 9e15, seq: 2 })]));
    const line = hub.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((o) => String(o["msg"]).includes("too far in the future"));
    expect(line).toMatchObject({ host: "h1", index: 1, count: 2 });
    expect(JSON.stringify(line)).not.toContain("9000000000000000");
  });

  it("the default skew is 24 h", async () => {
    hub = await makeHub({}, undefined, { wallClock: () => NOW });
    expect((await hub.post(batch([mkEnv({ ts: NOW + DAY_MS - 1 })]))).statusCode).toBe(200);
    expect((await hub.post(batch([mkEnv({ ts: NOW + DAY_MS + 1_000 })]))).statusCode).toBe(400);
  });

  it("compaction treats a stored far-future event as compactable, not a stopper, and warns with the count", async () => {
    const { store, ing } = mem();
    const old = session("A", "h1", CUT - 3 * DAY_MS, 3, 1);
    const future = mkEnv({ host: "h1", session_id: "F", seq: 50, ts: 9e15 });
    const recent = session("C", "h1", CUT + DAY_MS, 3, 100);
    ing.ingest("h1", [...old, future, ...recent]);
    store.upsertSample({
      session_id: "F",
      ts: 9e15,
      context_used_pct: 1,
      cost_usd: 1,
      five_hour_pct: null,
      five_hour_resets: null,
      seven_day_pct: null,
      seven_day_resets: null,
    });
    const before = derived(store).sessions;
    const log = capture();
    const r = await runRetention(
      store,
      log,
      { eventRetentionDays: 30, sampleRetentionDays: 30, maxOpenSessionsPerHost: OPEN },
      NOW,
    );
    expect(r.compact.events).toBe(old.length + 1);
    expect(r.compact.futureEvents).toBe(1);
    expect(store.countEvents()).toBe(recent.length);
    expect(r.samples).toBe(1); // the future-stamped sample is pruned too
    expect(log.lines.find((l) => l.level === "warn")).toMatchObject({
      obj: { future_events: 1 },
    });
    replay(store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(store).sessions).toEqual(before);
  });
});

describe("K2 expired envelopes", () => {
  it("transcript lines older than the watermark are still inserted; other kinds are counted as expired and logged", async () => {
    const { store, ing, log } = mem();
    ing.ingest("h1", session("A", "h1", CUT - 3 * DAY_MS, 3, 1));
    await compactEvents(store, capture(), {
      cutoffMs: CUT,
      maxTs: MAXTS,
      maxOpenSessionsPerHost: OPEN,
    });
    expect(store.getCompactionCut()).toBe(CUT);
    const tr = mkEnv({
      host: "h1",
      kind: "transcript",
      session_id: "A",
      ts: CUT - 40 * DAY_MS,
      payload: { start_line: 0, lines: ['{"a":1}', '{"a":2}'] },
    });
    delete (tr as { hook_event_name?: string }).hook_event_name;
    const hookOld = mkEnv({ host: "h1", session_id: "A", ts: CUT - 40 * DAY_MS });
    const events = store.countEvents();
    const r1 = ing.ingest("h1", [tr, hookOld]);
    expect(r1).toMatchObject({ accepted: 1, duplicates: 0, expired: 1 });
    expect(store.countEvents()).toBe(events);
    expect(derived(store).lines).toHaveLength(2);
    const w = log.lines.find((l) => l.msg.startsWith("ingest envelopes older"));
    expect(w?.level).toBe("warn");
    expect(w?.obj).toEqual({ host: "h1", expired: 1, count: 2 });
    // The same transcript again: primary-key dedup, a duplicate, not accepted twice.
    const r2 = ing.ingest("h1", [{ ...tr, id: mkEnv().id, seq: 9999 }]);
    expect(r2).toMatchObject({ accepted: 0, duplicates: 1, expired: 0 });
  });

  it("the ingest response carries expired only when non-zero", async () => {
    hub = await makeHub({}, undefined, { wallClock: () => NOW });
    expect((await hub.post(batch(session("A", "h1", CUT - DAY_MS, 3, 1)))).json()).toEqual({
      accepted: 3,
      last_seq: 3,
    });
    await compactEvents(hub.store, capture(), {
      cutoffMs: CUT,
      maxTs: MAXTS,
      maxOpenSessionsPerHost: OPEN,
    });
    const res = await hub.post(batch([mkEnv({ ts: CUT - DAY_MS, seq: 500 })]));
    expect(res.json()).toEqual({ accepted: 0, last_seq: 500, expired: 1 });
  });
});

describe("K3 concurrent compactors and the lease", () => {
  it("two compactors on one file, interleaved batch by batch, lose no folded event (SessionEnd survives)", async () => {
    const f = file();
    const a = Store.open(f.path);
    a.migrate();
    const ing = new Ingestor(a, capture());
    const envs = [
      ...session("A", "h1", CUT - 5 * DAY_MS, 12, 1, true),
      ...session("B", "h1", CUT - 4 * DAY_MS, 12, 100, true),
    ].sort((x, y) => x.ts - y.ts);
    for (let i = 0; i < envs.length; i += 6) ing.ingest("h1", envs.slice(i, i + 6));
    ing.ingest("h1", session("R", "h1", CUT + DAY_MS, 3, 500));
    const before = derived(a).sessions;
    const b = Store.open(f.path);
    const opts = { cutoffMs: CUT, maxTs: MAXTS, maxOpenSessionsPerHost: OPEN, batchSize: 3 };
    const [ra, rb] = await Promise.all([
      compactEvents(a, capture(), opts),
      compactEvents(b, capture(), opts),
    ]);
    expect(ra.events + rb.events).toBe(envs.length);
    expect(a.countEvents()).toBe(3);
    replay(a, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(a).sessions).toEqual(before);
    const states = (
      a.db
        .prepare("SELECT session_id, state FROM sessions WHERE session_id IN ('A','B')")
        .all() as { state: string }[]
    ).map((r) => r.state);
    expect(states).toEqual(["ended", "ended"]);
    b.close();
    a.close();
  });

  it("the lease: fresh while the hub serves, expired after ttl, released on stop", () => {
    const { store, log } = { ...mem() };
    let t = 1_000;
    const lease = startLease(store, log, { ttlMs: 15_000, refreshMs: 1_000_000, now: () => t });
    expect(leaseRemainingMs(store, t + 1)).toBe(14_999);
    expect(leaseRemainingMs(store, t + 15_001)).toBeNull();
    t += 5_000;
    lease.stop();
    expect(leaseRemainingMs(store, t)).toBeNull();
  });

  it("cli replay and compact refuse (exit 3, 'stop the hub first') while the lease is fresh; --force and a stale lease proceed", async () => {
    const f = file();
    const s = Store.open(f.path);
    s.migrate();
    // The CLI gate is what is under test, not the volume: a prefix keeps the file I/O small.
    const seq = SEQUENCES[0]!();
    new Ingestor(s, capture()).ingest(seq.host, seq.envelopes.slice(0, 40));
    s.setLease("hub-1", Date.now() + 60_000);
    s.close();
    const out: string[] = [];
    const run = (args: string[]) =>
      runCli(args, { HUB_EVENT_RETENTION_DAYS: "1" }, (l) => out.push(l), capture());
    expect(await run(["replay", "--db", f.path])).toBe(3);
    expect(out[0]).toMatch(/Stop the hub first/);
    expect(await run(["compact", "--db", f.path])).toBe(3);
    expect(await run(["replay", "--db", f.path, "--force"])).toBe(0);
    const s2 = Store.open(f.path);
    s2.setLease("hub-1", Date.now() - 1);
    s2.close();
    expect(await run(["compact", "--db", f.path])).toBe(0);
  });
});

describe("K4 batch budget", () => {
  it("a zero budget commits one slice per batch and still compacts everything correctly", async () => {
    const { store, ing } = mem();
    ing.ingest("h1", session("A", "h1", CUT - 5 * DAY_MS, 45, 1));
    ing.ingest("h1", session("R", "h1", CUT + DAY_MS, 2, 500));
    const before = derived(store).sessions;
    const r = await compactEvents(store, capture(), {
      cutoffMs: CUT,
      maxTs: MAXTS,
      maxOpenSessionsPerHost: OPEN,
      batchSize: 100,
      batchBudgetMs: 0,
    });
    expect(r.events).toBe(45);
    expect(r.batches).toBe(3); // 20 + 20 + 5
    expect(r.maxBatchMs).toBeGreaterThanOrEqual(r.p50BatchMs);
    replay(store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(store).sessions).toEqual(before);
  });
});

describe("K6 replay keeps the sample window", () => {
  it("does not resurrect samples older than the window from retained statusline events", () => {
    const { store, ing } = mem();
    const seq = SEQUENCES.map((m) => m()).find((s) => s.name === "all-statuslines")!;
    ing.ingest(seq.host, seq.envelopes);
    const all = derived(store).samples;
    expect(all.length).toBeGreaterThan(1);
    const mid = (all[1] as { ts: number }).ts;
    store.db.prepare("DELETE FROM statusline_samples WHERE ts < ?").run(mid);
    const kept = derived(store).samples;
    replay(store, capture(), {
      maxOpenSessionsPerHost: OPEN,
      sampleWindow: { minTs: mid, maxTs: Infinity },
    });
    expect(derived(store).samples).toEqual(kept);
    replay(store, capture(), { maxOpenSessionsPerHost: OPEN });
    expect(derived(store).samples).toEqual(all);
  });

  it("pruneSamples also removes future-stamped samples", async () => {
    const { store } = mem();
    for (const ts of [NOW - 40 * DAY_MS, NOW, 9e15]) {
      store.upsertSample({
        session_id: "s",
        ts,
        context_used_pct: 1,
        cost_usd: 1,
        five_hour_pct: null,
        five_hour_resets: null,
        seven_day_pct: null,
        seven_day_resets: null,
      });
    }
    const r = await pruneSamples(store, capture(), { cutoffMs: NOW - 30 * DAY_MS, maxTs: MAXTS });
    expect(r.samples).toBe(2);
  });
});

describe("K7 open-session cap parity between ingest and replay", () => {
  it("near the cap, ingest in one batch, in single-envelope batches, and replay admit the same sessions", () => {
    const cap = 3;
    const envs = [
      ...session("s1", "h1", NOW, 2, 1, true), // starts and ends: frees its slot
      ...session("s2", "h1", NOW + 10 * 60_000, 2, 10),
      ...session("s3", "h1", NOW + 20 * 60_000, 2, 20),
      ...session("s4", "h1", NOW + 30 * 60_000, 2, 30),
      ...session("s5", "h1", NOW + 40 * 60_000, 2, 40),
    ];
    const ids = (st: Store): string[] =>
      (
        st.db.prepare("SELECT session_id FROM sessions ORDER BY session_id").all() as {
          session_id: string;
        }[]
      ).map((r) => r.session_id);
    const mk = () => {
      const t = tempStore();
      cleanups.push(t.cleanup);
      t.store.migrate();
      return {
        store: t.store,
        ing: new Ingestor(t.store, capture(), Date.now, { maxOpenSessionsPerHost: cap }),
      };
    };
    const one = mk();
    one.ing.ingest("h1", envs);
    const singles = mk();
    for (const e of envs) singles.ing.ingest("h1", [e]);
    expect(ids(one.store)).toEqual(["s1", "s2", "s3", "s4"]); // s1 ended, so s4 fits; s5 is refused
    expect(ids(singles.store)).toEqual(ids(one.store));
    const before = derived(one.store).sessions;
    replay(one.store, capture(), { maxOpenSessionsPerHost: cap });
    expect(derived(one.store).sessions).toEqual(before);
  });
});

describe("K8 compaction_state arithmetic", () => {
  it("keeps the watermark monotone and sums compacted events (qualified columns)", () => {
    const { store } = mem();
    store.advanceCompaction(100, 5, 1);
    store.advanceCompaction(50, 7, 2);
    expect(store.getCompactionCut()).toBe(100);
    expect(store.db.prepare("SELECT compacted_events AS n FROM compaction_state").get()).toEqual({
      n: 12,
    });
  });
});

describe("K9 --db must be a hub database", () => {
  it("refuses a SQLite file without the hub's migrations unless --init, and does not touch it", async () => {
    const f = file();
    const raw = new Database(f.path);
    raw.exec("CREATE TABLE other (x INTEGER)");
    raw.close();
    const out: string[] = [];
    const run = (args: string[]) => runCli(args, {}, (l) => out.push(l), capture());
    expect(await run(["replay", "--db", f.path])).toBe(2);
    expect(out[0]).toMatch(/not a sessiondeck hub database/);
    const check = new Database(f.path, { readonly: true });
    const tables = (
      check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    check.close();
    expect(tables).toEqual(["other"]);
    expect(await run(["replay", "--db", f.path, "--init"])).toBe(0);
  });

  it("refuses a file that is not SQLite at all", async () => {
    const f = file();
    const fs = await import("node:fs");
    fs.writeFileSync(f.path, "not a database, just text".repeat(10));
    const out: string[] = [];
    expect(await runCli(["compact", "--db", f.path], {}, (l) => out.push(l), capture())).toBe(2);
  });
});
