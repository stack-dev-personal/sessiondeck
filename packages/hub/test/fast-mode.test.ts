import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { parseStoredSnapshot } from "../src/snapshot-parse.ts";
import { BASE_TS, readJson } from "./support/sequences.ts";
import { AUTH, batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});

let n = 0;
/** Fixture 13 carries its own fast_mode; strip it so each case controls the field. */
function base(): Record<string, unknown> {
  const rest = { ...(readJson("statusLine/13-max-used.json") as Record<string, unknown>) };
  delete rest["fast_mode"];
  return rest;
}
function statusEnv(over: Record<string, unknown>) {
  n += 1;
  return mkEnv({
    kind: "statusline",
    hook_event_name: undefined,
    session_id: "s1",
    ts: BASE_TS + n * 10_000,
    payload: { ...base(), session_id: "s1", ...over },
  });
}
const snap = (): SessionSnapshot =>
  parseStoredSnapshot((h.store.getSession("s1") as { snapshot: string }).snapshot);

describe("R3.11 statusLine fast_mode", () => {
  it("false, then true, then absent or null keeps true", async () => {
    await h.post(batch([statusEnv({ fast_mode: false })]));
    expect(snap().fast_mode).toBe(false);
    await h.post(batch([statusEnv({ fast_mode: true })]));
    expect(snap().fast_mode).toBe(true);
    await h.post(batch([statusEnv({})]));
    expect(snap().fast_mode).toBe(true);
    await h.post(batch([statusEnv({ fast_mode: null })]));
    expect(snap().fast_mode).toBe(true);
  });

  it("a stored snapshot without the field reads null", () => {
    const raw = JSON.parse(JSON.stringify({ session_id: "x", subagents: [] })) as Record<
      string,
      unknown
    >;
    expect(parseStoredSnapshot(JSON.stringify(raw)).fast_mode).toBeNull();
  });

  it("REST snapshots include fast_mode", async () => {
    await h.post(batch([statusEnv({ fast_mode: true })]));
    const res = await h.app.inject({ method: "GET", url: "/sessions/s1", headers: AUTH });
    expect((res.json() as SessionSnapshot).fast_mode).toBe(true);
    const list = await h.app.inject({ method: "GET", url: "/sessions", headers: AUTH });
    expect((list.json() as SessionSnapshot[])[0]?.fast_mode).toBe(true);
  });
});
