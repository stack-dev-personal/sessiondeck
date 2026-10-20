// R2.4: WAL checkpoints run on a worker thread so a commit never carries the fsync.
import { afterEach, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import type { Envelope } from "@sessiondeck/contract";
import { SAFETY_NET_FRAMES, startCheckpointer } from "../src/checkpoint.ts";
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
    await new Promise((r) => setTimeout(r, 25));
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
});
