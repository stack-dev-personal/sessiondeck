// R2.4: compaction yields to ingest and is capped per pass.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "@sessiondeck/contract";
import { Ingestor } from "../src/ingest/ingestor.ts";
import { IngestActivity } from "../src/ingest/activity.ts";
import {
  CAPPED_FOLLOW_UP_MS,
  DAY_MS,
  compactEvents,
  startRetentionTimer,
} from "../src/retention.ts";
import { batch, makeHub, mkEnv } from "./support/hub.ts";
import { tempStore } from "./helpers.ts";

const quiet = { info: () => undefined, warn: () => undefined };
const NOW = 1_800_000_000_000;
const cut = NOW - 30 * DAY_MS;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function seeded(n: number) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  t.store.migrate();
  const ing = new Ingestor(t.store, quiet);
  const envs: Envelope[] = Array.from({ length: n }, (_, i) =>
    mkEnv({ seq: i + 1, ts: cut - 2 * DAY_MS + i, session_id: `s${i % 3}` }),
  );
  for (let i = 0; i < n; i += 50) ing.ingest("h1", envs.slice(i, i + 50));
  return t.store;
}
const base = { cutoffMs: cut, maxTs: Infinity, maxOpenSessionsPerHost: 1000, batchSize: 5 };

describe("IngestActivity", () => {
  it("is idle until a request begins, busy while it runs, quiet only after quietMs", () => {
    let t = 1000;
    const a = new IngestActivity(() => t);
    expect(a.waitMs(15)).toBe(0);
    const end = a.begin();
    expect(a.waitMs(15)).toBe(15);
    t += 5;
    end();
    end(); // idempotent
    expect(a.active).toBe(0);
    t += 4;
    expect(a.waitMs(15)).toBe(11);
    t += 11;
    expect(a.waitMs(15)).toBe(0);
  });
});

describe("compaction yields to ingest", () => {
  it("waits for quiet before each batch and counts the wait", async () => {
    const store = seeded(20);
    let busyFor = 3; // the first three looks say "ingest active"
    const sleeps: number[] = [];
    const r = await compactEvents(store, quiet, {
      ...base,
      activity: { waitMs: () => (busyFor-- > 0 ? 7 : 0) },
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([7, 7, 7]);
    expect(r.yieldedMs).toBe(21);
    expect(r.forcedBatches).toBe(0);
    expect(r.events).toBe(20);
    expect(store.countEvents()).toBe(0);
  });

  it("never starves: past maxYieldMs the batch runs anyway", async () => {
    const store = seeded(20);
    const r = await compactEvents(store, quiet, {
      ...base,
      activity: { waitMs: () => 10 }, // permanently busy
      maxYieldMs: 30,
      sleep: async () => undefined,
    });
    expect(r.events).toBe(20);
    // One more look than batches: the final probe that finds nothing left also waits.
    expect(r.forcedBatches).toBe(r.batches + 1);
    expect(r.yieldedMs).toBe(30 * (r.batches + 1));
  });
});

describe("compaction cap", () => {
  it("stops at maxEvents with capped set, and the next pass continues where it stopped", async () => {
    const store = seeded(40);
    const a = await compactEvents(store, quiet, { ...base, maxEvents: 12 });
    expect(a.capped).toBe(true);
    expect(a.events).toBe(15); // whole batches of 5
    expect(store.countEvents()).toBe(25);
    const b = await compactEvents(store, quiet, { ...base, maxEvents: 0 });
    expect(b.capped).toBe(false);
    expect(store.countEvents()).toBe(0);
  });

  it("is not capped when everything fits", async () => {
    const store = seeded(10);
    const r = await compactEvents(store, quiet, { ...base, maxEvents: 10 });
    expect(r.events).toBe(10);
    expect(r.capped).toBe(false);
  });

  it("the timer schedules a follow-up pass within a minute after a capped one", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const store = seeded(30);
      const t = startRetentionTimer(store, quiet, {
        eventRetentionDays: 30,
        sampleRetentionDays: 30,
        maxOpenSessionsPerHost: 1000,
        intervalMs: 3_600_000,
        initialDelayMs: 1,
        compactBatchSize: 5,
        compactMaxEvents: 5,
      });
      await vi.advanceTimersByTimeAsync(2);
      expect(store.countEvents()).toBe(25);
      await vi.advanceTimersByTimeAsync(CAPPED_FOLLOW_UP_MS - 1000);
      expect(store.countEvents()).toBe(25);
      await vi.advanceTimersByTimeAsync(2000);
      expect(store.countEvents()).toBe(20);
      t.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server reports ingest activity", () => {
  it("begins once per POST /ingest, ends when the response closes, ignores other routes", async () => {
    const activity = new IngestActivity();
    let begun = 0;
    const orig = activity.begin.bind(activity);
    activity.begin = () => {
      begun++;
      return orig();
    };
    const h = await makeHub({}, undefined, { activity });
    try {
      await h.app.inject({ method: "GET", url: "/health" });
      expect(begun).toBe(0);
      const r = await h.post(batch([mkEnv()]));
      expect(r.statusCode).toBe(200);
      // inject() resolves after the response is written; 'close' follows on the next turn.
      await new Promise((res) => setImmediate(res));
      expect(begun).toBe(1);
      expect(activity.active).toBe(0);
      expect(activity.waitMs(1000)).toBeGreaterThan(0); // just ended: not yet quiet
    } finally {
      await h.cleanup();
    }
  });
});
