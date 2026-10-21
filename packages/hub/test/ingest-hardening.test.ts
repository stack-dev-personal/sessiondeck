// Fix round 1 for U2: one test group per security/review finding (D-S3-5 .. D-S3-8).
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { RateLimiter } from "../src/ingest/rate-limit.ts";
import { applyRateLimitStaleness, clampSnapshot } from "../src/ingest/reduce.ts";
import { MAX_PATH_LEN, exceedsDepth } from "../src/ingest/validate.ts";
import { BASE_TS, HUB_ROOT } from "./support/sequences.ts";
import { AUTH, batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

const live = (sid: string, pid: number, over = {}) =>
  mkEnv({
    kind: "liveness",
    hook_event_name: undefined,
    session_id: sid,
    payload: { pid, alive: true },
    ...over,
  });
const nest = (depth: number): unknown => {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = [v];
  return v; // `depth` nested arrays
};

describe("D-S3-5 rate limiting", () => {
  it("rotating host names cannot exceed the global cap", async () => {
    await h.cleanup();
    h = await makeHub(
      { HUB_INGEST_RATE: "10", HUB_INGEST_BURST: "20", HUB_MAX_HOSTS: "1000" },
      () => 5_000_000,
    );
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const host = `rot${i}`;
      const r = await h.post(batch([mkEnv({ host })], host));
      if (r.statusCode === 200) ok++;
      else {
        expect(r.statusCode).toBe(429);
        expect(r.body).toBe("");
        limited++;
      }
    }
    expect(ok).toBe(20); // the global burst, however many hosts are used
    expect(limited).toBe(40);
    expect(h.eventCount()).toBe(20);
  });

  it("one principal under every spelling of the scheme shares one global bucket", async () => {
    await h.cleanup();
    h = await makeHub({ HUB_INGEST_RATE: "1", HUB_INGEST_BURST: "2" }, () => 5_000_000);
    const send = (scheme: string) =>
      h.app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: AUTH.authorization.replace("Bearer", scheme),
          "content-type": "application/json",
        },
        payload: JSON.stringify(batch([mkEnv()])),
      });
    expect((await send("Bearer")).statusCode).toBe(200);
    expect((await send("bearer")).statusCode).toBe(200);
    expect((await send("BEARER")).statusCode).toBe(429);
    expect((await send("bEaReR")).statusCode).toBe(429);
  });

  it("a flood of other keys never resets or evicts a busy bucket (LRU of idle buckets only)", () => {
    let now = 1_000_000;
    const lim = new RateLimiter(1, 10, 3, () => now);
    expect(lim.take("real", 10)).toBe(true); // drained, oldest entry
    expect(lim.take("real", 5)).toBe(false);
    expect(lim.take("a", 1)).toBe(true);
    expect(lim.take("b", 1)).toBe(true);
    // table full of buckets that hold state: new keys are refused, nothing is cleared
    for (let i = 0; i < 1000; i++) expect(lim.take(`x${i}`, 1)).toBe(false);
    expect(lim.size()).toBe(3);
    expect(lim.take("real", 5)).toBe(false);
    now += 1000; // a and b refill to full (idle); real has 1 token
    expect(lim.take("new", 1)).toBe(true); // evicts the oldest IDLE bucket (a), never real
    expect(lim.size()).toBe(3);
    expect(lim.take("real", 5)).toBe(false); // real kept its state
    now += 5000;
    expect(lim.take("real", 5)).toBe(true);
  });

  it("hosts beyond HUB_MAX_HOSTS get 429 with an empty body and are not recorded", async () => {
    await h.cleanup();
    h = await makeHub({ HUB_MAX_HOSTS: "2" });
    expect((await h.post(batch([mkEnv({ host: "h1" })], "h1"))).statusCode).toBe(200);
    expect((await h.post(batch([mkEnv({ host: "h2" })], "h2"))).statusCode).toBe(200);
    const r = await h.post(batch([mkEnv({ host: "h3" })], "h3"));
    expect(r.statusCode).toBe(429);
    expect(r.body).toBe("");
    expect(h.store.getHost("h3")).toBeUndefined();
    expect(h.store.countHosts()).toBe(2);
    expect((await h.post(batch([mkEnv({ host: "h1" })], "h1"))).statusCode).toBe(200); // known host
    expect(h.eventCount()).toBe(3);
  });

  it("config reads the new limits", () => {
    const c = loadConfig({
      HUB_TOKEN: "a".repeat(16),
      HUB_MAX_HOSTS: "5",
      HUB_MAX_OPEN_SESSIONS: "7",
      HUB_HOST_RATE: "9",
    });
    expect([c.maxHosts, c.maxOpenSessionsPerHost, c.hostRate, c.hostBurst]).toEqual([
      5, 7, 9, 5000,
    ]);
    const d = loadConfig({ HUB_TOKEN: "a".repeat(16) });
    expect([d.ingestRate, d.ingestBurst, d.maxHosts]).toEqual([5000, 10000, 32]);
  });
});

describe("D-S3-6 last_seq is the batch's acknowledged max", () => {
  it("a huge seq in one batch does not appear in later responses", async () => {
    const huge = Number.MAX_SAFE_INTEGER;
    expect((await h.post(batch([mkEnv({ seq: huge })]))).json().last_seq).toBe(huge);
    const r = await h.post(batch([mkEnv({ seq: 5 }), mkEnv({ seq: 3 })]));
    expect(r.json()).toEqual({ accepted: 2, last_seq: 5 });
    const empty = await h.post(batch([]));
    expect(empty.json().last_seq).toBe(0);
  });

  it("duplicates are acknowledged, the response covers only the sent envelopes", async () => {
    const a = mkEnv({ seq: 10 });
    const b = mkEnv({ seq: 20 });
    await h.post(batch([a, b]));
    expect((await h.post(batch([a]))).json()).toEqual({ accepted: 0, last_seq: 10 });
    expect(h.store.getHost("h1")?.last_seq).toBe(20); // observability only, never returned
  });
});

describe("indexes (migration 2)", () => {
  const SIG =
    "SELECT 1 AS x FROM events WHERE session_id = ? AND ts > ? AND ts < ? AND signature = ? LIMIT 1";
  const SIG_NULL =
    "SELECT 1 AS x FROM events WHERE session_id IS NULL AND ts > ? AND ts < ? AND signature = ? LIMIT 1";
  const OPEN = "SELECT * FROM sessions WHERE host = ? AND (state < 'ended' OR state > 'ended')";
  const plan = (sql: string, ...args: unknown[]) =>
    (h.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(
      (r) => r.detail,
    );

  it("the plans below are the SQL store.ts really runs", () => {
    const src = readFileSync(path.join(HUB_ROOT, "src/db/store.ts"), "utf8");
    expect(src).toContain(`"${SIG}"`);
    expect(src).toContain(`"${SIG_NULL}"`);
    expect(src).toContain(`"${OPEN}"`);
  });

  it("the signature window is a covering range seek on (session_id, ts, signature)", () => {
    for (const [sql, args] of [
      [SIG, ["s", 1, 2, "sig"]],
      [SIG_NULL, [1, 2, "sig"]],
    ] as const) {
      const d = plan(sql, ...args);
      expect(d.join("\n")).toMatch(/COVERING INDEX events_session_ts_sig \(session_id/);
      expect(d.join("\n")).toMatch(/ts>\? AND ts<\?/);
      expect(d.some((x) => /^SCAN/.test(x))).toBe(false);
    }
  });

  it("the open-sessions lookup uses sessions_host_state and never scans the table", () => {
    const d = plan(OPEN, "h1");
    expect(d.join("\n")).toContain("sessions_host_state");
    expect(d.some((x) => /^SCAN/.test(x))).toBe(false);
  });

  it("the lookup returns open sessions only", async () => {
    await h.post(
      batch([
        mkEnv({ session_id: "open1", hook_event_name: "SessionStart" }),
        mkEnv({ session_id: "done", hook_event_name: "SessionStart" }),
        mkEnv({ session_id: "done", hook_event_name: "SessionEnd", payload: { reason: "other" } }),
      ]),
    );
    expect(h.store.listOpenSessionsForHost("h1").map((r) => r.session_id)).toEqual(["open1"]);
    expect(h.store.countOpenSessionsForHost("h1")).toBe(1);
  });
});

describe("supersede cost", () => {
  it("one open-sessions query per host per batch however many pid changes it holds", async () => {
    const spy = vi.spyOn(h.store, "listOpenSessionsForHost");
    const envs = Array.from({ length: 200 }, (_, i) => live(`s${i}`, 1000 + i));
    expect((await h.post(batch(envs))).json().accepted).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    await h.post(batch([live("s0", 5000), live("s1", 5001)]));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("sessions sharing a pid inside one batch still supersede each other", async () => {
    await h.post(batch([live("A", 77), live("B", 77), live("C", 88)]));
    const state = (id: string) =>
      (JSON.parse((h.store.getSession(id) as { snapshot: string }).snapshot) as SessionSnapshot)
        .ended_reason;
    expect(state("A")).toBe("superseded");
    expect(state("B")).toBeNull();
    expect(state("C")).toBeNull();
  });

  it("the open-session cap stops new sessions for a host, existing ones keep updating", async () => {
    await h.cleanup();
    h = await makeHub({ HUB_MAX_OPEN_SESSIONS: "2" });
    await h.post(batch([live("s1", 1), live("s2", 2), live("s3", 3)]));
    expect(h.store.getSession("s3")).toBeUndefined();
    expect(h.eventCount()).toBe(3); // the event is stored, only the session is not created
    expect(
      h.logLines().filter((l) => l["msg"] === "open session cap reached, session not created"),
    ).toHaveLength(1);
    await h.post(batch([live("s1", 9)]));
    expect(JSON.parse((h.store.getSession("s1") as { snapshot: string }).snapshot).pid).toBe(9);
  });
});

describe("D-S3-8 bounds", () => {
  const rejected = async (body: unknown, reason: string) => {
    const r = await h.post(body);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "invalid_envelope", reason });
    expect(h.eventCount()).toBe(0);
  };

  it("5001 envelopes is a 400 too_many_envelopes; 5000 passes", async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        mkEnv({ session_id: "s", seq: i, hook_event_name: "Stop", payload: { i } }),
      );
    await rejected(batch(mk(5001)), "too_many_envelopes");
    const r = await h.post(batch(mk(5000)));
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(5000);
  });

  it("payload depth: 64 passes, 65 is 400 envelopes[i].payload: too_deep", async () => {
    expect(exceedsDepth(nest(64), 64)).toBe(false);
    expect(exceedsDepth(nest(65), 64)).toBe(true);
    await rejected(
      batch([mkEnv(), mkEnv({ payload: nest(65) })]),
      "envelopes[1].payload: too_deep",
    );
    const r = await h.post(batch([mkEnv({ payload: nest(64) })]));
    expect(r.statusCode).toBe(200);
  });

  it("a 100000-level payload is a clean 400, not a 500 or a stack overflow", async () => {
    const n = 100_000;
    const deep = "[".repeat(n) + "]".repeat(n);
    const e = JSON.stringify(mkEnv({ payload: 0 })).replace('"payload":0', `"payload":${deep}`);
    const r = await h.postRaw(`{"host":"h1","envelopes":[${e}]}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toBe("envelopes[0].payload: too_deep");
    // the same depth in an object chain
    const objs = '{"a":'.repeat(n) + "1" + "}".repeat(n);
    const e2 = JSON.stringify(mkEnv({ payload: 0 })).replace('"payload":0', `"payload":${objs}`);
    expect((await h.postRaw(`{"host":"h1","envelopes":[${e2}]}`)).json().reason).toBe(
      "envelopes[0].payload: too_deep",
    );
  });

  it("string bounds: host 128, session_id 128, agent_id 128, hook_event_name 64", async () => {
    const long = (n: number) => "x".repeat(n);
    expect((await h.post(batch([mkEnv({ host: long(128) })], long(128)))).statusCode).toBe(200);
    await h.cleanup();
    h = await makeHub();
    await rejected(batch([mkEnv({ host: long(129) })], long(129)), "host: too_long");
    await rejected(batch([mkEnv({ session_id: long(129) })]), "envelopes[0].session_id: too_long");
    await rejected(batch([mkEnv({ agent_id: long(129) })]), "envelopes[0].agent_id: too_long");
    await rejected(
      batch([mkEnv({ hook_event_name: long(65) })]),
      "envelopes[0].hook_event_name: too_long",
    );
    expect(
      (await h.post(batch([mkEnv({ hook_event_name: "Stop".padEnd(64, "x") })]))).statusCode,
    ).toBe(200);
  });

  it("project_dir and cwd are truncated to the cap (not rejected) in the snapshot", async () => {
    const big = "/p".repeat(5000);
    const status = {
      session_id: "sp",
      workspace: { project_dir: big },
      cwd: big,
    };
    const r = await h.post(
      batch([
        mkEnv({ session_id: "sp", hook_event_name: "SessionStart", payload: { cwd: big } }),
        mkEnv({
          kind: "statusline",
          session_id: "sp",
          hook_event_name: undefined,
          payload: status,
        }),
      ]),
    );
    expect(r.statusCode).toBe(200);
    const s = JSON.parse(
      (h.store.getSession("sp") as { snapshot: string }).snapshot,
    ) as SessionSnapshot;
    expect(s.project_dir).toHaveLength(MAX_PATH_LEN);
    expect(s.cwd.length).toBeLessThanOrEqual(MAX_PATH_LEN);
    expect(h.store.getSession("sp")?.project_dir).toHaveLength(MAX_PATH_LEN);
    const small = createSnapshot({ session_id: "x", host: "h", cwd: "/w", ts: 1 });
    expect(clampSnapshot(small)).toBe(small);
  });

  it("the batch log carries a bounded host", async () => {
    await h.post(batch([mkEnv({ host: "y".repeat(128) })], "y".repeat(128)));
    const l = h.logLines().find((x) => x["msg"] === "ingest batch");
    expect(String(l?.["host"]).length).toBe(64);
  });
});

describe("transcript start_line is required", () => {
  it("a chunk without start_line is a reducer exception and writes no lines", async () => {
    const e = mkEnv({
      kind: "transcript",
      hook_event_name: undefined,
      payload: { lines: ["a", "b"] },
    });
    expect((await h.post(batch([e]))).statusCode).toBe(200);
    expect(h.app.hub.reducerExceptionCount()).toBe(1);
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM transcript_lines").get()).toEqual({
      n: 0,
    });
  });

  it("successive chunks with their start_line all land", async () => {
    const mk = (start_line: number, lines: string[]) =>
      mkEnv({ kind: "transcript", hook_event_name: undefined, payload: { start_line, lines } });
    await h.post(batch([mk(0, ["a", "b"]), mk(2, ["c"]), mk(3, ["d", "e"])]));
    const rows = h.store.db.prepare("SELECT raw FROM transcript_lines ORDER BY line_no").all();
    expect(rows.map((r) => (r as { raw: string }).raw)).toEqual(["a", "b", "c", "d", "e"]);
    expect(h.app.hub.reducerExceptionCount()).toBe(0);
  });
});

describe("routing and SQL errors", () => {
  it("a statusline or subagents row from another host cannot overwrite a session", async () => {
    const own = mkEnv({
      kind: "statusline",
      session_id: "s1",
      hook_event_name: undefined,
      payload: { cost: { total_cost_usd: 1.5 } },
    });
    await h.post(batch([own]));
    const evil = mkEnv({
      kind: "statusline",
      host: "h2",
      session_id: "s1",
      hook_event_name: undefined,
      payload: { cost: { total_cost_usd: 999 }, context_window: { used_percentage: 1 } },
    });
    const evilSub = mkEnv({
      kind: "subagents",
      host: "h2",
      session_id: "s1",
      hook_event_name: undefined,
      payload: { tasks: [] },
    });
    const r = await h.post(batch([evil, evilSub], "h2"));
    expect(r.statusCode).toBe(200);
    const s = JSON.parse(
      (h.store.getSession("s1") as { snapshot: string }).snapshot,
    ) as SessionSnapshot;
    expect(s.cost.usd).toBe(1.5);
    expect(s.host).toBe("h1");
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM statusline_samples").get()).toEqual({
      n: 1,
    });
    expect(h.app.hub.reducerExceptionCount()).toBe(0);
  });

  it.each(["listOpenSessionsForHost", "getSession", "countOpenSessionsForHost"] as const)(
    "a SqliteError from %s rolls the whole batch back (500), it is not a reducer exception",
    async (method) => {
      // listOpen: reached through a pid change; getSession: the pre-try load; count: a new session.
      vi.spyOn(h.store, method).mockImplementation(() => {
        throw new Database.SqliteError("disk I/O error", "SQLITE_IOERR");
      });
      const r = await h.post(batch([mkEnv({ session_id: "ok" }), live("s9", 4242)]));
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ error: "internal" });
      expect(h.app.hub.reducerExceptionCount()).toBe(0);
      expect(h.eventCount()).toBe(0);
      expect(h.store.countHosts()).toBe(0);
    },
  );
});

describe("R2.7 read-time staleness", () => {
  const snap = (
    five: [number | null, number | null] | null,
    seven: [number | null, number | null] | null,
  ): SessionSnapshot => {
    const s = createSnapshot({ session_id: "s", host: "h", cwd: "/", ts: BASE_TS });
    const w = (v: [number | null, number | null] | null) =>
      v === null ? null : { used_pct: v[0], resets_at: v[1] };
    return { ...s, rate_limits: { five_hour: w(five), seven_day: w(seven), captured_at: BASE_TS } };
  };

  it("nulls used_pct of a window at or past resets_at and keeps resets_at", () => {
    const s = snap([40, 1000], [10, 5000]);
    const out = applyRateLimitStaleness(s, 1000);
    expect(out.rate_limits.five_hour).toEqual({ used_pct: null, resets_at: 1000 });
    expect(out.rate_limits.seven_day).toEqual({ used_pct: 10, resets_at: 5000 });
    expect(applyRateLimitStaleness(s, 6000).rate_limits.seven_day?.used_pct).toBeNull();
  });

  it("leaves a window before its reset untouched and returns the same object", () => {
    const s = snap([40, 1000], [10, 5000]);
    expect(applyRateLimitStaleness(s, 999)).toBe(s);
  });

  it("handles null windows, null resets_at and already-null percentages", () => {
    const s = snap(null, [null, 1]);
    expect(applyRateLimitStaleness(s, 10_000)).toBe(s);
    const t = snap([55, null], null);
    expect(applyRateLimitStaleness(t, 10 ** 15)).toBe(t);
  });

  it("does not mutate its input", () => {
    const s = snap([40, 1000], null);
    const frozen = JSON.stringify(s);
    applyRateLimitStaleness(s, 2000);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
