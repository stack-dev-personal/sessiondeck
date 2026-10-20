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
}

export async function makeHub(
  env: Record<string, string> = {},
  now?: () => number,
): Promise<TestHub> {
  const t = tempStore();
  t.store.migrate();
  const logs: string[] = [];
  const app = buildServer({
    config: loadConfig({ HUB_TOKEN: TOKEN, ...env }),
    store: t.store,
    logStream: { write: (m) => void logs.push(m) },
    ...(now ? { now } : {}),
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
