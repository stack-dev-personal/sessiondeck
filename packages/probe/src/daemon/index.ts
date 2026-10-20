import { mkdirSync } from "node:fs";
import type { Envelope } from "@sessiondeck/contract";
import pkg from "../../package.json" with { type: "json" };
import { type ProbeConfig, readConfig } from "../config/config.ts";
import { hostOs } from "../envelope.ts";
import {
  daemonDir,
  daemonLockPath,
  daemonLogPath,
  daemonStatePath,
  outboxDir,
  probeConfigFile,
  rejectedDir,
  spoolDir,
} from "../paths.ts";
import type { SpoolLine } from "../spool-format.ts";
import { ulid } from "../ulid.ts";
import { Forwarder, MAX_BATCH_ENVELOPES, MAX_BATCH_MS, MAX_BODY_BYTES } from "./forwarder.ts";
import { createFileLogger } from "./log.ts";
import { acquireLock } from "./lock.ts";
import { createOutbox } from "./outbox.ts";
import type { ComponentContext, DaemonComponent, Logger } from "./types.ts";

export type { ComponentContext, DaemonComponent, Logger } from "./types.ts";

export const HEARTBEAT_MS = 30_000;
export const DAEMON_VERSION: string = pkg.version;

export interface DaemonOptions {
  /** Probe home; every daemon file lives under it. */
  home: string;
  /** Config source; default reads `<home>/probe.json` before each send attempt. */
  config?: ProbeConfig | (() => Promise<ProbeConfig | undefined> | ProbeConfig | undefined);
  components?: DaemonComponent[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Resolves after ms or when the signal aborts. Injectable so tests can run time fast. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  rng?: () => number;
  pollMs?: number;
  batchMs?: number;
  maxBatch?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  backoffCapMs?: number;
  /** 0 disables the heartbeat timer (the first heartbeat is still queued at start). */
  heartbeatMs?: number;
  /** Also write log lines to stderr. */
  stderr?: boolean;
}

export interface DaemonHandle {
  /** Queues a daemon-originated envelope (no seq) for forwarding. */
  enqueue(line: SpoolLine): void;
  /** Envelopes read or journaled but not acknowledged. */
  pending(): number;
  /** Next seq to be assigned (the committed value). */
  nextSeq(): number;
  /** Graceful stop: components stop, the lock is released. */
  stop(): Promise<void>;
  /** Stops without flushing or stopping components (test stand-in for a crash); releases the lock. */
  kill(): Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** Starts the daemon; undefined when another daemon already holds the lock for this home. */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle | undefined> {
  const home = opts.home;
  const now = opts.now ?? Date.now;
  mkdirSync(daemonDir(home), { recursive: true, mode: 0o700 });
  const lock = acquireLock(daemonLockPath(home));
  if (!lock) return undefined;
  const fileLog = createFileLogger(daemonLogPath(home), now);
  const log: Logger = opts.stderr
    ? (l, m) => {
        fileLog(l, m);
        process.stderr.write(`${l} ${m}\n`);
      }
    : fileLog;

  const getConfig =
    typeof opts.config === "function"
      ? opts.config
      : opts.config !== undefined
        ? (): ProbeConfig => opts.config as ProbeConfig
        : (): Promise<ProbeConfig | undefined> => readConfig(probeConfigFile(home));

  const enqueueRaw = createOutbox(outboxDir(home), now);
  const components = opts.components ?? [];
  let hostName = "unknown";
  try {
    hostName = (await getConfig())?.host ?? hostName;
  } catch (e) {
    log("error", `config unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const fwd = new Forwarder({
    statePath: daemonStatePath(home),
    spoolDir: spoolDir(home),
    outboxDir: outboxDir(home),
    rejectedDir: rejectedDir(home),
    getConfig,
    log,
    fetch: opts.fetch ?? globalThis.fetch,
    now,
    sleep: opts.sleep ?? realSleep,
    rng: opts.rng ?? Math.random,
    pollMs: opts.pollMs ?? 50,
    batchMs: opts.batchMs ?? MAX_BATCH_MS,
    maxBatch: opts.maxBatch ?? MAX_BATCH_ENVELOPES,
    maxBodyBytes: opts.maxBodyBytes ?? MAX_BODY_BYTES,
    requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
    ...(opts.backoffCapMs !== undefined ? { backoffCapMs: opts.backoffCapMs } : {}),
    onSpoolLine: (env: Envelope) => {
      for (const c of components) c.onSpoolLine?.(env);
    },
  });

  const heartbeat = async (): Promise<void> => {
    let lag = 0;
    try {
      lag = await fwd.lagBytes();
    } catch {
      // lag is informational
    }
    enqueueRaw({
      v: 1,
      id: ulid(now()),
      kind: "probe",
      host: hostName,
      os: hostOs(),
      session_id: null,
      ts: now(),
      payload: {
        type: "heartbeat",
        pid: process.pid,
        version: DAEMON_VERSION,
        spool_lag_bytes: lag,
        pending: fwd.pendingCount(),
      },
    });
  };

  await fwd.start();
  const ctx: ComponentContext = { home, host: hostName, log, enqueue: enqueueRaw };
  for (const c of components) await c.start?.(ctx);
  let timer: NodeJS.Timeout | undefined;
  await heartbeat();
  if ((opts.heartbeatMs ?? HEARTBEAT_MS) > 0) {
    timer = setInterval(
      () => void heartbeat().catch(() => undefined),
      opts.heartbeatMs ?? HEARTBEAT_MS,
    );
    timer.unref();
  }
  log("info", `daemon started pid=${process.pid} home=${home}`);

  let ended = false;
  const finish = async (graceful: boolean): Promise<void> => {
    if (ended) return;
    ended = true;
    if (timer) clearInterval(timer);
    await fwd.stop();
    if (graceful) {
      for (const c of components) {
        try {
          await c.stop?.();
        } catch (e) {
          log("error", `component ${c.name} stop: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      log("info", "daemon stopped");
    }
    lock.release();
  };

  return {
    enqueue: enqueueRaw,
    pending: () => fwd.pendingCount(),
    nextSeq: () => fwd.nextSeq(),
    stop: () => finish(true),
    kill: () => finish(false),
  };
}
