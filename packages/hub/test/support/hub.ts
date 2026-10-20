import type { Envelope } from "@sessiondeck/contract";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { loadConfig } from "../../src/config.ts";
import type { Store } from "../../src/db/store.ts";
import { buildServer } from "../../src/server.ts";
import { tempStore } from "../helpers.ts";
import { BASE_TS, ulid } from "./sequences.ts";

export const TOKEN = "t".repeat(24);
export const AUTH = { authorization: `Bearer ${TOKEN}` };

export interface TestHub {
  app: FastifyInstance;
  store: Store;
  logs: string[];
  cleanup: () => Promise<void>;
  post: (body: unknown) => Promise<LightMyRequestResponse>;
  postRaw: (payload: string, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
  logLines: () => Record<string, unknown>[];
  eventCount: () => number;
  /** Starts listening on an ephemeral loopback port; returns ws:// and http:// base URLs. */
  listen: () => Promise<{ ws: string; http: string }>;
}

export async function makeHub(
  env: Record<string, string> = {},
  now?: () => number,
  extra: {
    heartbeatMs?: number;
    maxBufferedBytes?: number;
    refuseFallbackMs?: number;
    wallClock?: () => number;
  } = {},
): Promise<TestHub> {
  const t = tempStore();
  t.store.migrate();
  const logs: string[] = [];
  // loadConfig refuses burst sizes below the max batch; tests that exercise the limiter with tiny
  // buckets set them on the config object after validation.
  const { HUB_INGEST_BURST: ib, HUB_HOST_BURST: hb, ...rest } = env;
  const config = loadConfig({ HUB_TOKEN: TOKEN, ...rest });
  if (ib !== undefined) config.ingestBurst = Number(ib);
  if (hb !== undefined) config.hostBurst = Number(hb);
  const app = buildServer({
    config,
    store: t.store,
    logStream: { write: (m) => void logs.push(m) },
    ...(now ? { now } : {}),
    ...extra,
  });
  await app.ready();
  return {
    app,
    store: t.store,
    logs,
    cleanup: async () => {
      await app.close();
      t.cleanup();
    },
    post: (body) =>
      app.inject({
        method: "POST",
        url: "/ingest",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: JSON.stringify(body),
      }),
    postRaw: (payload, headers = {}) =>
      app.inject({
        method: "POST",
        url: "/ingest",
        headers: { ...AUTH, "content-type": "application/json", ...headers },
        payload,
      }),
    logLines: () =>
      logs.flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    listen: async () => {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as { port: number }).port;
      return { ws: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
    },
    eventCount: () =>
      (t.store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  };
}

let counter = 0;
/** A valid envelope; counter-based id and seq unless overridden. */
export function mkEnv(over: Partial<Envelope> = {}): Envelope {
  counter++;
  return {
    v: 1,
    id: ulid(1_000_000 + counter),
    kind: "hook",
    host: "h1",
    os: "linux",
    session_id: "s1",
    hook_event_name: "UserPromptSubmit",
    ts: BASE_TS + counter * 10_000,
    seq: counter,
    payload: { prompt: `p${counter}`, cwd: "/w" },
    ...over,
  };
}

export const batch = (envelopes: Envelope[], host = "h1") => ({ host, envelopes });

import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { rowOf } from "../../src/ingest/ingestor.ts";

/** Stores a snapshot directly (bypassing ingest) and returns it. */
export function seedSession(
  store: Store,
  id: string,
  over: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  const snap = {
    ...createSnapshot({ session_id: id, host: "h1", cwd: "/w", ts: BASE_TS }),
    ...over,
  };
  store.upsertSession(rowOf(snap));
  return snap;
}
