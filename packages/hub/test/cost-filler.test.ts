import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostFiller } from "../src/derive/cost-filler.ts";
import type { BatchCommitted } from "../src/ingest/ingestor.ts";

// R2.12 / R2.4: the fill is debounced, never rebuilds the usage index on a busy ingest path, and
// stands down when the hub shuts down mid-fill.

const usageBatch = (session: string): BatchCommitted =>
  ({
    transcripts: [{ session_id: session, lines: [{ raw: '{"message":{"usage":{"x":1}}}' }] }],
    sessions: [],
  }) as unknown as BatchCommitted;

interface Rig {
  filler: CostFiller;
  refresh: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  errors: object[];
  state: { stale: boolean; waitMs: number; now: number; projectsVersion: number };
  projectScans: { n: number };
}

function rig(refreshImpl?: () => Promise<void>): Rig {
  const state = { stale: false, waitMs: 0, now: 0, projectsVersion: 0 };
  const projectScans = { n: 0 };
  const refresh = vi.fn(refreshImpl ?? (() => Promise.resolve()));
  const transaction = vi.fn((fn: () => void) => fn());
  const store = {
    listSessionProjects: () => {
      projectScans.n++;
      return [];
    },
    get projectsVersion() {
      return state.projectsVersion;
    },
    transaction,
    getSession: () => undefined,
    upsertSession: () => undefined,
  };
  const usage = {
    refresh,
    memo: (_k: string, _t: unknown, compute: () => unknown) => compute(),
    index: { staleProjects: () => state.stale, sessions: () => [], version: 1 },
  };
  const errors: object[] = [];
  const filler = new CostFiller(
    store as never,
    usage as never,
    { current: () => ({}) } as never,
    undefined,
    () => undefined,
    { error: (o) => void errors.push(o) },
    {
      debounceMs: 1000,
      rebuildQuietMs: 2000,
      rebuildMaxDeferMs: 60_000,
      ingestWaitMs: () => state.waitMs,
      clock: () => state.now,
    },
  );
  return { filler, refresh, transaction, errors, state, projectScans };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CostFiller debounce", () => {
  it("many batches inside the window cost one refresh", async () => {
    const r = rig();
    for (let i = 0; i < 20; i++) r.filler.onBatch(usageBatch(`s${i % 3}`));
    await vi.advanceTimersByTimeAsync(999);
    expect(r.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await r.filler.idle();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("idle() flushes without waiting for the timer", async () => {
    const r = rig();
    r.filler.onBatch(usageBatch("s"));
    await r.filler.idle();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("CostFiller index rebuild", () => {
  it("waits while ingest is busy and a project_dir change makes refresh a full rebuild", async () => {
    const r = rig();
    r.state.stale = true;
    r.state.waitMs = 500;
    r.filler.onBatch(usageBatch("s"));
    await vi.advanceTimersByTimeAsync(1001);
    expect(r.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.refresh).not.toHaveBeenCalled();
    r.state.waitMs = 0; // ingest went quiet
    await vi.advanceTimersByTimeAsync(2001);
    await r.filler.idle();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("runs the rebuild anyway once the defer budget is spent", async () => {
    const r = rig();
    r.state.stale = true;
    r.state.waitMs = 500;
    r.filler.onBatch(usageBatch("s"));
    await vi.advanceTimersByTimeAsync(1001);
    expect(r.refresh).not.toHaveBeenCalled();
    r.state.now = 61_000;
    await vi.advanceTimersByTimeAsync(2001);
    await r.filler.idle();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not wait when no index row is stale, however busy ingest is", async () => {
    const r = rig();
    r.state.waitMs = 500;
    r.filler.onBatch(usageBatch("s"));
    await vi.advanceTimersByTimeAsync(1001);
    await r.filler.idle();
    expect(r.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("CostFiller shutdown", () => {
  it("closing during the refresh writes nothing and logs nothing", async () => {
    let release: () => void = () => undefined;
    const r = rig(() => new Promise<void>((resolve) => (release = resolve)));
    r.filler.onBatch(usageBatch("s"));
    await vi.advanceTimersByTimeAsync(1001);
    expect(r.refresh).toHaveBeenCalledTimes(1);
    r.filler.close();
    release();
    await r.filler.idle();
    expect(r.transaction).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
  });
});

describe("CostFiller rebuild check", () => {
  it("reads the sessions table only when store.projectsVersion changed", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.filler.onBatch(usageBatch(`s${i}`));
      await r.filler.idle(); // forced flushes skip the check; use the timer path
    }
    r.projectScans.n = 0;
    for (let i = 0; i < 5; i++) {
      r.filler.onBatch(usageBatch(`t${i}`));
      await vi.advanceTimersByTimeAsync(1001);
      await r.filler.idle();
    }
    expect(r.projectScans.n).toBe(1); // first flush scans, the next four reuse the result
    r.state.projectsVersion++;
    r.state.stale = true;
    r.filler.onBatch(usageBatch("u"));
    await vi.advanceTimersByTimeAsync(1001);
    await r.filler.idle();
    expect(r.projectScans.n).toBe(2);
  });
});
