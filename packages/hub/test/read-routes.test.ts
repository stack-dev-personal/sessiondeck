import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { rowOf } from "../src/ingest/ingestor.ts";
import { AUTH, batch, makeHub, mkEnv, seedSession, type TestHub } from "./support/hub.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
let h: TestHub;
beforeEach(async () => {
  h = await makeHub({}, () => NOW);
});
afterEach(async () => {
  await h.cleanup();
});

const get = (url: string, headers: Record<string, string> = AUTH) =>
  h.app.inject({ method: "GET", url, headers });

/** A stored session row in `state`, ended `agoMin` minutes before NOW (ended_at set explicitly). */
function seedEnded(id: string, state: string, agoMin: number | null, useEndedAt: boolean): void {
  const snap = createSnapshot({ session_id: id, host: "h1", cwd: "/w", ts: NOW - 60 * MIN });
  const at = agoMin === null ? null : NOW - agoMin * MIN;
  h.store.upsertSession({
    ...rowOf({ ...snap, state: state as SessionSnapshot["state"] }),
    state,
    last_event_at: useEndedAt ? NOW - 90 * MIN : at,
    ended_at: useEndedAt ? at : null,
  });
}

describe("R2.6 GET /sessions?live=1", () => {
  it("keeps ended and exited sessions for 10 minutes, and every other state", async () => {
    seedEnded("ended-9-ea", "ended", 9, true);
    seedEnded("ended-11-ea", "ended", 11, true);
    seedEnded("exited-9-le", "exited", 9, false);
    seedEnded("exited-11-le", "exited", 11, false);
    seedEnded("exited-9-ea", "exited", 9, true);
    seedEnded("ended-11-le", "ended", 11, false);
    for (const st of [
      "starting",
      "working",
      "waiting_permission",
      "waiting_input",
      "idle",
      "error",
    ]) {
      // Old activity does not matter for a non-ended session.
      seedEnded(`open-${st}`, st, 600, false);
    }
    const ids = ((await get("/sessions?live=1")).json() as SessionSnapshot[])
      .map((s) => s.session_id)
      .sort();
    expect(ids).toEqual(
      [
        "ended-9-ea",
        "exited-9-le",
        "exited-9-ea",
        ...["starting", "working", "waiting_permission", "waiting_input", "idle", "error"].map(
          (s) => `open-${s}`,
        ),
      ].sort(),
    );
    const all = (await get("/sessions")).json() as SessionSnapshot[];
    expect(all).toHaveLength(12);
  });

  it("exactly 10 minutes old is still live, 10 minutes and 1 ms is not", async () => {
    seedEnded("edge-in", "ended", 10, true);
    h.store.upsertSession({
      ...rowOf(createSnapshot({ session_id: "edge-out", host: "h1", cwd: "/w", ts: NOW })),
      state: "ended",
      ended_at: NOW - 10 * MIN - 1,
    });
    const ids = ((await get("/sessions?live=1")).json() as SessionSnapshot[]).map(
      (s) => s.session_id,
    );
    expect(ids).toEqual(["edge-in"]);
  });
});

describe("R2.7 read-time staleness on REST", () => {
  it("a window past resets_at is null on /sessions/:id and /sessions", async () => {
    const win = { used_pct: 61, resets_at: NOW - 1000 };
    const live = { used_pct: 12, resets_at: NOW + 1000 };
    const base = seedSession(h.store, "stale", {});
    h.store.upsertSession(
      rowOf({ ...base, rate_limits: { ...base.rate_limits, five_hour: win, seven_day: live } }),
    );
    const one = (await get("/sessions/stale")).json() as SessionSnapshot;
    expect(one.rate_limits.five_hour).toEqual({ used_pct: null, resets_at: NOW - 1000 });
    expect(one.rate_limits.seven_day).toEqual(live);
    const list = (await get("/sessions")).json() as SessionSnapshot[];
    expect(list[0]?.rate_limits.five_hour?.used_pct).toBeNull();
    const liveList = (await get("/sessions?live=1")).json() as SessionSnapshot[];
    expect(liveList[0]?.rate_limits.five_hour?.used_pct).toBeNull();
    // The stored row is untouched (staleness is a read-time view).
    const stored = JSON.parse(h.store.getSession("stale")!.snapshot) as SessionSnapshot;
    expect(stored.rate_limits.five_hour?.used_pct).toBe(61);
  });
});

describe("REST reads", () => {
  it("lists newest first and honors limit; 404 for unknown session", async () => {
    for (let i = 0; i < 5; i++) {
      seedSession(h.store, `s${i}`, { started_at: NOW - (5 - i) * MIN, last_event_at: NOW });
    }
    const ids = ((await get("/sessions?limit=3")).json() as SessionSnapshot[]).map(
      (s) => s.session_id,
    );
    expect(ids).toEqual(["s4", "s3", "s2"]);
    const r = await get("/sessions/nope");
    expect([r.statusCode, r.body]).toEqual([404, ""]);
    expect((await get("/sessions/nope/events")).statusCode).toBe(404);
    expect((await get("/sessions/nope/transcript")).statusCode).toBe(404);
  });

  it.each([
    "/sessions?limit=0",
    "/sessions?limit=1001",
    "/sessions?limit=abc",
    "/sessions?limit=-1",
    "/sessions?limit=1&limit=2",
    "/sessions?live=2",
    "/sessions/s/events?after=x",
    "/sessions/s/events?limit=5000",
    "/sessions/s/transcript?after=-3",
    "/sessions/s/transcript?limit=0",
  ])("400 on %s", async (url) => {
    seedSession(h.store, "s");
    const r = await get(url);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "invalid_query" });
  });

  it("events: ordered by seq, after cursor, limit", async () => {
    const envs = Array.from({ length: 6 }, () => mkEnv({ session_id: "ev" }));
    expect((await h.post(batch(envs))).statusCode).toBe(200);
    const seqs = envs.map((e) => e.seq);
    const all = (await get("/sessions/ev/events")).json() as { events: { seq: number }[] };
    expect(all.events.map((e) => e.seq)).toEqual(seqs);
    const page = (await get(`/sessions/ev/events?after=${seqs[1]}&limit=2`)).json() as {
      events: { seq: number; payload: unknown; id: string }[];
    };
    expect(page.events.map((e) => e.seq)).toEqual([seqs[2], seqs[3]]);
    expect(page.events[0]?.payload).toMatchObject({ cwd: "/w" });
    expect(page.events[0]).not.toHaveProperty("signature");
  });

  it("transcript: raw lines with line_no and agent_id, cursor, agent filter", async () => {
    const t = (agent: string | undefined, start: number, lines: string[]) =>
      mkEnv({
        kind: "transcript",
        session_id: "tr",
        hook_event_name: undefined,
        ...(agent ? { agent_id: agent } : {}),
        payload: { start_line: start, lines },
      });
    expect(
      (
        await h.post(
          batch([
            mkEnv({ session_id: "tr" }),
            t(undefined, 0, ['{"a":1}', '{"a":2}', '{"a":3}']),
            t("sub", 0, ['{"b":1}']),
          ]),
        )
      ).statusCode,
    ).toBe(200);
    type L = { lines: { agent_id: string; line_no: number; raw: string }[] };
    const main = (await get("/sessions/tr/transcript?agent_id=")).json() as L;
    expect(main.lines.map((l) => [l.agent_id, l.line_no, l.raw])).toEqual([
      ["", 0, '{"a":1}'],
      ["", 1, '{"a":2}'],
      ["", 2, '{"a":3}'],
    ]);
    const after = (await get("/sessions/tr/transcript?agent_id=&after=0&limit=1")).json() as L;
    expect(after.lines.map((l) => l.line_no)).toEqual([1]);
    const sub = (await get("/sessions/tr/transcript?agent_id=sub")).json() as L;
    expect(sub.lines).toHaveLength(1);
    expect(((await get("/sessions/tr/transcript")).json() as L).lines).toHaveLength(4);
  });

  it("transcript: after requires agent_id; paging per agent loses nothing (D-S3-13)", async () => {
    const t = (agent: string | undefined, start: number, lines: string[]) =>
      mkEnv({
        kind: "transcript",
        session_id: "pg",
        hook_event_name: undefined,
        ...(agent ? { agent_id: agent } : {}),
        payload: { start_line: start, lines },
      });
    await h.post(
      batch([
        mkEnv({ session_id: "pg" }),
        t(undefined, 0, ['{"a":1}', '{"a":2}', '{"a":3}']),
        t("sub", 0, ['{"b":1}']),
      ]),
    );
    const r = await get("/sessions/pg/transcript?after=1");
    expect([r.statusCode, r.json()]).toEqual([
      400,
      { error: "invalid_query", reason: "after requires agent_id" },
    ]);
    type L = { lines: { agent_id: string; line_no: number }[] };
    // page through every agent with an explicit agent_id and a cursor
    const seen: string[] = [];
    for (const agent of ["", "sub"]) {
      let after = -1;
      for (;;) {
        const q = after < 0 ? "" : `&after=${after}`;
        const page = (
          await get(`/sessions/pg/transcript?agent_id=${agent}&limit=2${q}`)
        ).json() as L;
        if (page.lines.length === 0) break;
        for (const l of page.lines) seen.push(`${l.agent_id}:${l.line_no}`);
        after = page.lines.at(-1)!.line_no;
      }
    }
    expect(seen).toEqual([":0", ":1", ":2", "sub:0"]);
    // no after, no agent_id: all agents ordered (agent_id, line_no)
    const all = (await get("/sessions/pg/transcript")).json() as L;
    expect(all.lines.map((l) => `${l.agent_id}:${l.line_no}`)).toEqual(seen);
  });

  it("projects and hosts", async () => {
    seedSession(h.store, "p1", { project_dir: "/proj/a" });
    h.store.db
      .prepare("INSERT INTO projects (project_dir, name) VALUES (?, ?)")
      .run("/proj/b", "B");
    expect(await h.post(batch([mkEnv()]))).toMatchObject({ statusCode: 200 });
    const p = (await get("/projects")).json() as { projects: { project_dir: string }[] };
    expect(p.projects.map((x) => x.project_dir)).toEqual(["/proj/a", "/proj/b"]);
    const hs = (await get("/hosts")).json() as { hosts: Record<string, unknown>[] };
    expect(hs.hosts).toHaveLength(1);
    expect(Object.keys(hs.hosts[0]!).sort()).toEqual(["host", "last_seen", "last_seq", "os"]);
  });
});

describe("R2.8 on the new REST routes", () => {
  it("401 with an empty body and no token echo for every route", async () => {
    seedSession(h.store, "s");
    for (const url of [
      "/sessions",
      "/sessions?live=1",
      "/sessions/s",
      "/sessions/s/events",
      "/sessions/s/transcript",
      "/projects",
      "/hosts",
      "/sessions?limit=zzz",
    ]) {
      for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
        const r = await get(url, headers);
        expect([r.statusCode, r.body]).toEqual([401, ""]);
      }
    }
  });
});
