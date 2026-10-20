import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE_TS } from "./support/sequences.ts";
import { batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});

const same = {
  hook_event_name: "PreToolUse",
  payload: { tool_name: "Bash", tool_input: { c: "ls" } },
};

describe("R2.2 dedup", () => {
  it("same id in separate batches is stored once, both 200", async () => {
    const e = mkEnv();
    expect((await h.post(batch([e]))).json()).toEqual({ accepted: 1, last_seq: e.seq });
    const r2 = await h.post(batch([e]));
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ accepted: 0, last_seq: e.seq });
    expect(h.eventCount()).toBe(1);
  });

  it("same id within one batch is stored once", async () => {
    const e = mkEnv();
    const r = await h.post(batch([e, e]));
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(1);
    expect(h.eventCount()).toBe(1);
  });

  it("same (host, seq) with a different id and payload is stored once", async () => {
    const a = mkEnv({ seq: 50 });
    const b = mkEnv({ seq: 50 });
    const r = await h.post(batch([a, b]));
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(1);
    expect((await h.post(batch([mkEnv({ seq: 50 })]))).json().accepted).toBe(0);
    expect(h.eventCount()).toBe(1);
  });

  it("all-duplicate batch still returns the host's last_seq", async () => {
    const es = [mkEnv(), mkEnv(), mkEnv()];
    await h.post(batch(es));
    const r = await h.post(batch(es));
    expect(r.json()).toEqual({ accepted: 0, last_seq: es[2]?.seq });
  });

  it("identical signature material 4.9 s apart is stored once, 5.1 s apart both", async () => {
    const t = BASE_TS;
    const a = mkEnv({ ...same, ts: t });
    const b = mkEnv({ ...same, ts: t + 4900 });
    const c = mkEnv({ ...same, ts: t + 10_000 });
    const d = mkEnv({ ...same, ts: t + 10_000 + 5100 });
    const r = await h.post(batch([a, b, c, d]));
    expect(r.json().accepted).toBe(3); // b is 4.9 s after a (dup); d is 5.1 s after c (stored)
    const ids = (
      h.store.db.prepare("SELECT id FROM events ORDER BY ts").all() as { id: string }[]
    ).map((x) => x.id);
    expect(ids).toEqual([a.id, c.id, d.id]);
  });

  it("5.1 s apart is stored twice; exactly 5 s apart is stored twice", async () => {
    const t = BASE_TS;
    const r = await h.post(
      batch([
        mkEnv({ ...same, ts: t }),
        mkEnv({ ...same, ts: t + 5100 }),
        mkEnv({ ...same, ts: t + 100_000 }),
        mkEnv({ ...same, ts: t + 105_000 }),
      ]),
    );
    expect(r.json().accepted).toBe(4);
  });

  it("a pair 1 s apart straddling a 5 s bucket boundary is stored once", async () => {
    const boundary = Math.ceil(BASE_TS / 5000) * 5000;
    const a = mkEnv({ ...same, ts: boundary - 500 });
    const b = mkEnv({ ...same, ts: boundary + 500 });
    expect(Math.floor(a.ts / 5000)).not.toBe(Math.floor(b.ts / 5000));
    const r = await h.post(batch([a, b]));
    expect(r.json().accepted).toBe(1);
  });

  it("window applies across batches and to out-of-order arrival", async () => {
    const t = BASE_TS;
    await h.post(batch([mkEnv({ ...same, ts: t + 3000 })]));
    const r = await h.post(batch([mkEnv({ ...same, ts: t })]));
    expect(r.json().accepted).toBe(0);
  });

  it("different payload, session, agent or kind within 5 s is not a duplicate", async () => {
    const t = BASE_TS;
    const r = await h.post(
      batch([
        mkEnv({ ...same, ts: t }),
        mkEnv({ ...same, ts: t + 1, payload: { tool_name: "Bash", tool_input: { c: "pwd" } } }),
        mkEnv({ ...same, ts: t + 2, session_id: "other" }),
        mkEnv({ ...same, ts: t + 3, agent_id: "a1" }),
        mkEnv({ ...same, ts: t + 4, kind: "probe", session_id: null, hook_event_name: undefined }),
      ]),
    );
    expect(r.json().accepted).toBe(5);
  });

  it("payload key order does not change the signature", async () => {
    const t = BASE_TS;
    const r = await h.post(
      batch([
        mkEnv({ ...same, ts: t, payload: { a: 1, b: { x: 1, y: 2 } } }),
        mkEnv({ ...same, ts: t + 1, payload: { b: { y: 2, x: 1 }, a: 1 } }),
      ]),
    );
    expect(r.json().accepted).toBe(1);
  });
});
