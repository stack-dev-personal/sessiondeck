// R2.4: WAL checkpoints run on a worker thread so a commit never carries the fsync.
import { afterEach, describe, expect, it, vi } from "vitest";
import { statSync } from "node:fs";
import type { Envelope } from "@sessiondeck/contract";
import {
  MAX_CONSECUTIVE_FAILURES,
  SAFETY_NET_FRAMES,
  failureReporter,
  startCheckpointer,
} from "../src/checkpoint.ts";
import { Ingestor } from "../src/ingest/ingestor.ts";
import { mkEnv } from "./support/hub.ts";
import { tempStore } from "./helpers.ts";

const quiet = { info: () => undefined, warn: () => undefined };
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("startCheckpointer", () => {
  it("moves the writer's automatic checkpoint out to the safety net and the worker moves the WAL into the database file", async () => {
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    t.store.migrate();
    const dbPath = t.store.db.name;
    const ck = startCheckpointer(t.store, dbPath, quiet, 25);
    expect(t.store.db.pragma("wal_autocheckpoint", { simple: true })).toBe(SAFETY_NET_FRAMES);
    const before = statSync(dbPath).size;
    const ing = new Ingestor(t.store, quiet);
    for (let b = 0; b < 30; b++) {
      const envs: Envelope[] = [];
      for (let i = 0; i < 20; i++) {
        envs.push(mkEnv({ seq: b * 20 + i + 1, ts: Date.now() }));
      }
      ing.ingest("h1", envs);
    }
    // Under the default 1000-page threshold nothing would have reached the main file yet.
    await waitFor(() => statSync(dbPath).size > before + 20_000);
    expect(t.store.countEvents()).toBeGreaterThan(0);
    await ck.stop();
    // The writer keeps working after the worker is gone, and nothing was lost.
    const n = t.store.countEvents();
    ing.ingest("h1", [mkEnv({ seq: 100_000, ts: Date.now() })]);
    expect(t.store.countEvents()).toBe(n + 1);
  });

  it("is a no-op for an in-memory database", async () => {
    const t = tempStore();
    cleanup = t.cleanup;
    const ck = startCheckpointer(t.store, ":memory:", quiet);
    await ck.stop();
    expect(t.store.db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
  });

  it("restores automatic checkpoints and warns when the worker cannot open the database", async () => {
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    t.store.migrate();
    const warns: string[] = [];
    const log = { info: () => undefined, warn: (_o: object, m: string) => void warns.push(m) };
    const ck = startCheckpointer(t.store, "/nonexistent-dir/x/y.db", log, 25);
    await waitFor(() => warns.length > 0);
    expect(warns[0]).toBe("checkpoint worker unavailable, automatic checkpoints restored");
    expect(t.store.db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
    await ck.stop();
  });
});

describe("consecutive failure fallback (F5)", () => {
  it("drops the worker and restores wal_autocheckpoint = 1000 after 100 failed checkpoints", async () => {
    // A worker that reports an error on every tick, 100 times, then keeps running.
    vi.resetModules();
    const real = await import("node:worker_threads");
    const src = `
      const { parentPort } = require("node:worker_threads");
      for (let i = 0; i < ${MAX_CONSECUTIVE_FAILURES}; i++) parentPort.postMessage({ error: "locked" });
      setInterval(() => {}, 1000);
    `;
    vi.doMock("node:worker_threads", () => ({
      ...real,
      Worker: class extends real.Worker {
        constructor(_src: string, o: object) {
          super(src, o as never);
        }
      },
    }));
    try {
      const { startCheckpointer: start } = await import("../src/checkpoint.ts");
      const t = tempStore({ file: true });
      cleanup = t.cleanup;
      t.store.migrate();
      const warns: { o: unknown; m: string }[] = [];
      const log = {
        info: () => undefined,
        warn: (o: object, m: string) => void warns.push({ o, m }),
      };
      const ck = start(t.store, t.store.db.name, log, 25);
      expect(t.store.db.pragma("wal_autocheckpoint", { simple: true })).toBe(SAFETY_NET_FRAMES);
      await waitFor(() => t.store.db.pragma("wal_autocheckpoint", { simple: true }) === 1000);
      expect(warns.map((w) => w.m)).toContain(
        "checkpoint worker unavailable, automatic checkpoints restored",
      );
      expect(JSON.stringify(warns.at(-1)?.o)).toContain("too many consecutive");
      await ck.stop();
    } finally {
      vi.doUnmock("node:worker_threads");
    }
  });
});

describe("failureReporter (S3, R4)", () => {
  it("logs the first failure, counts the rest, and summarises after the interval", () => {
    const lines: { o: Record<string, unknown>; m: string }[] = [];
    const log = {
      info: () => undefined,
      warn: (o: object, m: string) => void lines.push({ o: o as Record<string, unknown>, m }),
    };
    let now = 1_000;
    const r = failureReporter(log, () => now, 60_000);
    for (let i = 0; i <= 600; i++) {
      r.failed("locked");
      now += 100;
    }
    // 10 failures/s for 60 s: the first, then exactly one summary (601 calls, 600 ms apart cumulatively).
    expect(lines.length).toBe(2);
    expect(lines[0]?.o["suppressed"]).toBe(0);
    expect(Number(lines[1]?.o["suppressed"])).toBeGreaterThan(500);
  });
});
