/** Test helpers for reducer tests. All hook payloads built here are SYNTHETIC (documented field lists only). */
import { TEST_ULID } from "./helpers";
import type { Envelope } from "../src/envelope";
import { createSnapshot } from "../src/snapshot";
import type { SessionSnapshot } from "../src/snapshot";
import type { SessionState } from "../src/state-names";

export const T0 = 1_000;
export const SESSION = "sess-1";
export const HOST = "test-host";

export function snap(
  state: SessionState = "starting",
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    ...createSnapshot({ session_id: SESSION, host: HOST, cwd: "<HOME>/proj", ts: T0 }),
    state,
    ...overrides,
  };
}

export function hook(
  name: string | undefined,
  payload: unknown = {},
  ts: number = T0 + 1,
  extra: Partial<Envelope<"hook">> = {},
): Envelope<"hook"> {
  return {
    v: 1,
    id: TEST_ULID,
    kind: "hook",
    host: HOST,
    os: "win32",
    session_id: SESSION,
    ...(name === undefined ? {} : { hook_event_name: name }),
    ts,
    seq: 1,
    payload,
    ...extra,
  };
}

export function liveness(payload: unknown, ts: number = T0 + 1): Envelope<"liveness"> {
  return {
    v: 1,
    id: TEST_ULID,
    kind: "liveness",
    host: HOST,
    os: "win32",
    session_id: SESSION,
    ts,
    seq: 1,
    payload,
  };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
