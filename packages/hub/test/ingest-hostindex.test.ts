import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH, batch, makeHub, mkEnv, seedSession, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});

describe("host pid index", () => {
  it("loads open sessions from the listed rows, not one getSession per session", async () => {
    for (let i = 0; i < 30; i++) seedSession(h.store, `open${i}`, { pid: 1000 + i });
    let point = 0;
    const orig = h.store.getSession.bind(h.store);
    h.store.getSession = (id) => {
      point++;
      return orig(id);
    };
    // A liveness envelope that sets a new pid triggers supersede and so hostIndex(host).
    const r = await h.post(
      batch([
        mkEnv({ kind: "liveness", session_id: "open0", payload: { pid: 1000, alive: true } }),
      ]),
    );
    expect(r.statusCode).toBe(200);
    // One load for the envelope's own session; none per open session (was 31).
    expect(point).toBeLessThanOrEqual(2);
    const s = await h.app.inject({ method: "GET", url: "/sessions/open1", headers: AUTH });
    expect(s.statusCode).toBe(200);
  });

  it("still supersedes a same-pid session found through the index", async () => {
    seedSession(h.store, "old", { pid: 4321 });
    await h.post(
      batch([mkEnv({ kind: "liveness", session_id: "new", payload: { pid: 4321, alive: true } })]),
    );
    const old = await h.app.inject({ method: "GET", url: "/sessions/old", headers: AUTH });
    expect(old.json()).toMatchObject({ state: "ended", ended_reason: "superseded" });
  });
});
