// WAL checkpoints off the ingest path (R2.4).
//
// SQLite's default is to checkpoint inside the commit that grows the WAL past 1000 pages. Under
// synchronous = NORMAL that checkpoint fsyncs the WAL and the database file, so one ingest batch in
// about thirty stalls the event loop for 30 to 50 ms (measured, docs/HUB.md "Load harness"), which
// is the whole p95. Here a worker thread with its own connection runs `wal_checkpoint(PASSIVE)`
// every CHECKPOINT_INTERVAL_MS (100 ms), so the backlog stays small, and the writer's own automatic checkpoint is moved out
// to a large safety-net threshold (SAFETY_NET_FRAMES). PASSIVE never blocks writers or readers. Durability is unchanged: synchronous stays NORMAL, a committed transaction is in the
// WAL exactly as before, and the checkpoint (the only fsync) is the same operation on another thread.
//
// The worker is an inline script so the bundled hub needs no second file. If the worker cannot
// start or dies, the writer's automatic checkpointing is switched back on.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Store } from "./db/store.ts";
import type { Logger } from "./ingest/ingestor.ts";

export const CHECKPOINT_INTERVAL_MS = 100;

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.sqlite);
const db = new Database(workerData.dbPath);
db.pragma("busy_timeout = 5000");
db.pragma("wal_autocheckpoint = 0");
const run = () => {
  try { db.pragma("wal_checkpoint(PASSIVE)"); }
  catch (e) { parentPort.postMessage({ error: String(e && e.message) }); }
};
const timer = setInterval(run, workerData.intervalMs);
parentPort.on("message", (m) => {
  if (m === "stop") { clearInterval(timer); run(); db.close(); parentPort.postMessage("stopped"); parentPort.close(); }
});
`;

/**
 * Safety net on the writer: past this many WAL frames (4 KiB pages; 8192 is about 32 MiB) SQLite
 * checkpoints inside the commit, as it always did. A PASSIVE checkpoint on another connection can
 * never restart the WAL while writes continue (the tail always grows during the copy); only the
 * writer's own checkpoint can, because nobody else is appending. The worker has already copied
 * almost everything by then, so this one is short, and it bounds the WAL file.
 */
export const SAFETY_NET_FRAMES = 8_192;

export interface Checkpointer {
  stop: () => Promise<void>;
}

/** No-op for an in-memory store. Never throws: on failure the writer keeps automatic checkpoints. */
export function startCheckpointer(
  store: Store,
  dbPath: string,
  log: Logger,
  intervalMs: number = CHECKPOINT_INTERVAL_MS,
): Checkpointer {
  if (dbPath === ":memory:") return { stop: async () => undefined };
  const fallback = (why: string): void => {
    try {
      store.db.pragma("wal_autocheckpoint = 1000");
    } catch {
      // store already closed
    }
    log.warn({ err: why }, "checkpoint worker unavailable, automatic checkpoints restored");
  };
  let worker: Worker;
  try {
    const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
    // A literal, like every pragma here (SAFETY_NET_FRAMES is asserted equal to it by the test).
    store.db.pragma("wal_autocheckpoint = 8192");
    // After a restart the WAL file is cut back to this size instead of staying at its high-water mark.
    store.db.pragma("journal_size_limit = 67108864");
    worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { sqlite, dbPath, intervalMs },
    });
  } catch (err) {
    fallback(err instanceof Error ? err.message : "unknown");
    return { stop: async () => undefined };
  }
  let stopping = false;
  let exited = false;
  const gone = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  worker.on("message", (m: unknown) => {
    if (typeof m === "object" && m !== null && "error" in m) {
      log.warn({ err: String((m as { error: unknown }).error) }, "wal checkpoint failed");
    }
  });
  worker.on("error", (err) => {
    if (!stopping) fallback(err.message);
  });
  worker.on("exit", () => {
    exited = true;
    if (!stopping) fallback("worker exited");
  });
  worker.unref();
  return {
    stop: async () => {
      stopping = true;
      if (exited) return;
      worker.postMessage("stop");
      await Promise.race([gone, new Promise<void>((r) => setTimeout(r, 2_000))]);
      await worker.terminate();
    },
  };
}
