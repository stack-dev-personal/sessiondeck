import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@sessiondeck/contract";
import type { BatchCommitted } from "../src/ingest/ingestor.ts";
import { BASE_TS, readJson } from "./support/sequences.ts";
import { batch, makeHub, mkEnv, type TestHub } from "./support/hub.ts";

let h: TestHub;
beforeEach(async () => {
  h = await makeHub();
});
afterEach(async () => {
  await h.cleanup();
});

const snap = (id = "s1"): SessionSnapshot =>
  JSON.parse((h.store.getSession(id) as { snapshot: string }).snapshot) as SessionSnapshot;

function statusEnv(over: Record<string, unknown>, ts = BASE_TS, id = "s1") {
  return mkEnv({
    kind: "statusline",
    hook_event_name: undefined,
    session_id: id,
    ts,
    payload: { ...readJson("statusLine/13-max-used.json"), session_id: id, ...over },
  });
}
const samples = () =>
  h.store.db.prepare("SELECT * FROM statusline_samples ORDER BY ts").all() as Record<
    string,
    unknown
  >[];

describe("statusline reduction", () => {
  it("updates context, cost, model, rate limits, prompt cache and appends a sample", async () => {
    await h.post(batch([statusEnv({})]));
    const s = snap();
    expect(s.context).toEqual({ used_pct: 96, window: 1000000, input: 956420, output: 5 });
    expect(s.cost.usd).toBeCloseTo(151.93180295);
    expect(s.cost).toMatchObject({ duration_ms: 9390149, lines_added: 13282, lines_removed: 1196 });
    expect(s.model).toEqual({ id: "claude-fable-5-1", display_name: "Fable 5.1" });
    expect(s.effort).toBe("xhigh");
    expect(s.project_dir).toContain("PROJECT_A");
    expect(s.rate_limits).toEqual({
      five_hour: { used_pct: 62, resets_at: 1792101600000 },
      seven_day: { used_pct: 32, resets_at: 1792555200000 },
      captured_at: BASE_TS,
    });
    expect(s.prompt_cache).toEqual({ warm: true, expires_at: 1792100117000 });
    expect(samples()).toEqual([
      {
        session_id: "s1",
        ts: BASE_TS,
        context_used_pct: 96,
        cost_usd: s.cost.usd,
        five_hour_pct: 62,
        five_hour_resets: 1792101600000,
        seven_day_pct: 32,
        seven_day_resets: 1792555200000,
      },
    ]);
    expect(h.store.getSession("s1")).toMatchObject({ project_dir: s.project_dir });
  });

  it("R2.7: a window past resets_at is null in snapshot and sample", async () => {
    const pastSec = BASE_TS / 1000 - 600;
    await h.post(
      batch([
        statusEnv({
          rate_limits: {
            five_hour: { used_percentage: 50, resets_at: pastSec },
            seven_day: { used_percentage: 20, resets_at: BASE_TS / 1000 + 86400 },
          },
        }),
      ]),
    );
    const s = snap();
    expect(s.rate_limits.five_hour).toEqual({ used_pct: null, resets_at: pastSec * 1000 });
    expect(s.rate_limits.seven_day?.used_pct).toBe(20);
    expect(samples()[0]).toMatchObject({
      five_hour_pct: null,
      five_hour_resets: pastSec * 1000,
      seven_day_pct: 20,
    });
  });

  it("R2.7: a stored window goes null once a later tick passes its resets_at", async () => {
    const resetSec = BASE_TS / 1000 + 100;
    await h.post(
      batch([
        statusEnv({ rate_limits: { five_hour: { used_percentage: 50, resets_at: resetSec } } }),
      ]),
    );
    expect(snap().rate_limits.five_hour?.used_pct).toBe(50);
    const later = statusEnv({ rate_limits: undefined }, BASE_TS + 200_000);
    await h.post(batch([later]));
    expect(snap().rate_limits.five_hour).toEqual({ used_pct: null, resets_at: resetSec * 1000 });
  });

  it("R2.7: used_percentage -5 and 140 are nulled and logged with the envelope id", async () => {
    const future = BASE_TS / 1000 + 3600;
    const e = statusEnv({
      context_window: { context_window_size: 1000000, used_percentage: 140 },
      rate_limits: {
        five_hour: { used_percentage: -5, resets_at: future },
        seven_day: { used_percentage: 140, resets_at: future },
      },
    });
    const r = await h.post(batch([e]));
    expect(r.statusCode).toBe(200);
    const s = snap();
    expect(s.rate_limits.five_hour?.used_pct).toBeNull();
    expect(s.rate_limits.seven_day?.used_pct).toBeNull();
    expect(s.context.used_pct).toBeNull();
    expect(samples()[0]).toMatchObject({
      five_hour_pct: null,
      seven_day_pct: null,
      context_used_pct: null,
    });
    const warns = h.logLines().filter((l) => l["msg"] === "used_percentage out of range, nulled");
    expect(warns.map((l) => l["field"]).sort()).toEqual([
      "context_window.used_percentage",
      "rate_limits.five_hour.used_percentage",
      "rate_limits.seven_day.used_percentage",
    ]);
    for (const l of warns) {
      expect(l["envelope_id"]).toBe(e.id);
      expect(JSON.stringify(l)).not.toContain("PROJECT");
    }
    expect(h.app.hub.reducerExceptionCount()).toBe(0);
  });
});

describe("subagents and transcript", () => {
  it("subagent rows are refreshed from subagentStatusLine", async () => {
    const start = mkEnv({
      hook_event_name: "SubagentStart",
      agent_id: "ag1",
      payload: { cwd: "/w", agent_type: "general-purpose", agent_id: "ag1" },
    });
    const sub = mkEnv({
      kind: "subagents",
      hook_event_name: undefined,
      payload: {
        tasks: [{ id: "ag1", tokenCount: 77, contextWindowSize: 1000, model: "m1" }, { id: "zzz" }],
      },
    });
    await h.post(batch([start, sub]));
    expect(snap().subagents).toEqual([
      {
        agent_id: "ag1",
        agent_type: "general-purpose",
        started_at: start.ts,
        ended_at: null,
        tokens: 77,
        context_window: 1000,
        model: "m1",
      },
    ]);
  });

  it("transcript lines are stored raw, agent_id '' for the main session, re-sent lines ignored", async () => {
    const e1 = mkEnv({
      kind: "transcript",
      hook_event_name: undefined,
      payload: { start_line: 0, lines: ['{"x":1}', "not json at all"] },
    });
    const e2 = mkEnv({
      kind: "transcript",
      hook_event_name: undefined,
      agent_id: "ag9",
      payload: { start_line: 0, lines: ["l0"] },
    });
    const e3 = mkEnv({
      kind: "transcript",
      hook_event_name: undefined,
      payload: { start_line: 1, lines: ["not json at all", "third"] },
    });
    const got: BatchCommitted[] = [];
    h.app.hub.events.on("batch", (b) => got.push(b));
    await h.post(batch([e1, e2, e3]));
    const rows = h.store.db
      .prepare("SELECT agent_id, line_no, raw FROM transcript_lines ORDER BY agent_id, line_no")
      .all();
    expect(rows).toEqual([
      { agent_id: "", line_no: 0, raw: '{"x":1}' },
      { agent_id: "", line_no: 1, raw: "not json at all" },
      { agent_id: "", line_no: 2, raw: "third" },
      { agent_id: "ag9", line_no: 0, raw: "l0" },
    ]);
    // line 1 was already stored: only new lines are broadcast
    const main = got[0]?.transcripts.find((t) => t.agent_id === "");
    expect(main?.lines.map((l) => l.line_no)).toEqual([0, 1, 2]);
    expect(h.store.getSession("s1")).toBeUndefined(); // transcript alone creates no snapshot
  });
});

describe("reducer exceptions", () => {
  it("are logged with the envelope id, counted, stored, and never fail the batch", async () => {
    const bad = mkEnv({
      kind: "statusline",
      hook_event_name: undefined,
      payload: "SECRET_PAYLOAD_TEXT",
    });
    const badT = mkEnv({ kind: "transcript", hook_event_name: undefined, payload: { lines: 5 } });
    const good = mkEnv({ hook_event_name: "SessionStart", payload: { cwd: "/w", model: "m" } });
    const r = await h.post(batch([bad, badT, good]));
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(3);
    expect(h.app.hub.reducerExceptionCount()).toBe(2);
    expect(h.eventCount()).toBe(3);
    const warns = h.logLines().filter((l) => l["msg"] === "reducer exception");
    expect(warns.map((l) => l["envelope_id"])).toEqual([bad.id, badT.id]);
    expect(h.logs.join("")).not.toContain("SECRET_PAYLOAD_TEXT");
    expect(snap().state).toBe("starting");
  });

  it("an ingest log line is written per batch with count and ms", async () => {
    await h.post(batch([mkEnv(), mkEnv()]));
    const l = h.logLines().filter((x) => x["msg"] === "ingest batch");
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ host: "h1", count: 2, accepted: 2 });
    expect(typeof l[0]?.["ms"]).toBe("number");
  });
});

describe("transaction and notification", () => {
  it("a forced SQL failure rolls the whole batch back and returns a sanitized 500", async () => {
    h.store.db.exec("DROP TABLE statusline_samples");
    const got: BatchCommitted[] = [];
    h.app.hub.events.on("batch", (b) => got.push(b));
    const r = await h.post(batch([mkEnv({ hook_event_name: "SessionStart" }), statusEnv({})]));
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "internal" });
    expect(r.body).not.toContain("statusline_samples");
    expect(h.eventCount()).toBe(0);
    expect(h.store.getSession("s1")).toBeUndefined();
    expect(h.store.getHost("h1")).toBeUndefined();
    expect(got).toHaveLength(0);
  });

  it("emits once per committed batch with the changed snapshots, not for rejected batches", async () => {
    const got: BatchCommitted[] = [];
    h.app.hub.events.on("batch", (b) => got.push(b));
    await h.post(
      batch([mkEnv({ session_id: "a" }), mkEnv({ session_id: "b" }), mkEnv({ session_id: "a" })]),
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.sessions.map((s) => s.session_id).sort()).toEqual(["a", "b"]);
    await h.post({ host: "h1", envelopes: [{}] });
    await h.postRaw("{bad");
    expect(got).toHaveLength(1);
    const dup = mkEnv({ session_id: "c" });
    await h.post(batch([dup]));
    await h.post(batch([dup]));
    expect(got).toHaveLength(3);
    expect(got[2]?.sessions).toEqual([]);
  });

  it("a throwing listener does not fail the request", async () => {
    h.app.hub.events.on("batch", () => {
      throw new Error("boom");
    });
    const r = await h.post(batch([mkEnv()]));
    expect(r.statusCode).toBe(200);
    expect(h.logLines().some((l) => l["msg"] === "ingest listener threw")).toBe(true);
  });

  it("hosts row tracks os, last_seen and last_seq", async () => {
    await h.cleanup();
    h = await makeHub({}, () => 12345);
    await h.post(batch([mkEnv({ seq: 4 }), mkEnv({ seq: 2 })]));
    expect(h.store.getHost("h1")).toEqual({
      host: "h1",
      os: "linux",
      last_seen: 12345,
      last_seq: 4,
    });
  });

  it("sessions row columns follow the snapshot", async () => {
    await h.post(batch([mkEnv({ hook_event_name: "SessionStart", payload: { cwd: "/w" } })]));
    const row = h.store.getSession("s1");
    expect(row).toMatchObject({ host: "h1", state: "starting", ended_at: null });
  });
});
