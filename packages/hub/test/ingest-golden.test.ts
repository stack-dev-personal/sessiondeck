import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Envelope, SessionSnapshot } from "@sessiondeck/contract";
import { oracle, type Golden } from "../scripts/gen-golden.ts";
import { batch, makeHub, type TestHub } from "./support/hub.ts";
import {
  BASE_TS,
  HUB_ROOT,
  SEQUENCES,
  STEP_MS,
  goldenSession,
  readJson,
  type Seq,
} from "./support/sequences.ts";

/**
 * Wall-clock fields ignored in the golden compare: none. Every time in a snapshot, sample or
 * transcript row derives from envelope ts; hosts.last_seen (wall clock) is not part of the golden.
 */
function dump(h: TestHub): Golden {
  const snapshots: Record<string, SessionSnapshot> = {};
  const rows = h.store.db
    .prepare("SELECT session_id, snapshot FROM sessions ORDER BY session_id")
    .all() as {
    session_id: string;
    snapshot: string;
  }[];
  for (const r of rows) snapshots[r.session_id] = JSON.parse(r.snapshot) as SessionSnapshot;
  const samples = h.store.db
    .prepare("SELECT * FROM statusline_samples ORDER BY session_id, ts")
    .all() as Golden["samples"];
  const transcript_lines = h.store.db
    .prepare(
      "SELECT session_id, agent_id, line_no, ts, raw FROM transcript_lines ORDER BY session_id, agent_id, line_no",
    )
    .all() as Golden["transcript_lines"];
  return { snapshots, samples, transcript_lines };
}

const golden = (name: string): Golden =>
  JSON.parse(readFileSync(path.join(HUB_ROOT, "test/golden", `${name}.json`), "utf8")) as Golden;

type Mode = "plain" | "interleaved-dups" | "resent-after";
let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

async function run(seq: Seq, size: number, mode: Mode): Promise<TestHub> {
  const h = await makeHub();
  hub = h;
  const envs: Envelope[] =
    mode === "interleaved-dups" ? seq.envelopes.flatMap((e) => [e, e]) : seq.envelopes;
  for (let i = 0; i < envs.length; i += size) {
    const r = await h.post(batch(envs.slice(i, i + size), seq.host));
    expect(r.statusCode).toBe(200);
  }
  if (mode === "resent-after") {
    for (let i = 0; i < seq.envelopes.length; i += size) {
      const r = await h.post(batch(seq.envelopes.slice(i, i + size), seq.host));
      expect(r.json().accepted).toBe(0);
    }
  }
  return h;
}

describe("R2.3 golden replay over HTTP", () => {
  for (const make of SEQUENCES) {
    const seq = make();
    describe(seq.name, () => {
      it("committed golden file equals a fresh oracle fold (generator is current)", () => {
        expect(golden(seq.name)).toEqual(JSON.parse(JSON.stringify(oracle(seq))));
      });
      // Every golden file runs in every mode at least once; size 1 and "all" bracket the plain mode.
      // Redundant cross-product cells were dropped to keep `pnpm -r test` inside the R0.5 60 s budget.
      // Size 1 (one envelope per request) is replayed for the small sequences here; the golden-session
      // timeline test below replays golden-session one envelope at a time and compares the full golden.
      const cells: [number, Mode][] = [
        ...(seq.envelopes.length <= 100 ? ([[1, "plain"]] as [number, Mode][]) : []),
        [100_000, "plain"],
        [7, "interleaved-dups"],
        [7, "resent-after"],
      ];
      for (const [size, mode] of cells) {
        it(`batch size ${size === 100_000 ? "all" : size}, ${mode}`, async () => {
          const h = await run(seq, size, mode);
          expect(dump(h)).toEqual(golden(seq.name));
          expect(h.eventCount()).toBe(seq.envelopes.length);
          expect(h.app.hub.reducerExceptionCount()).toBe(0);
        });
      }
    });
  }

  it("covers every envelope kind", () => {
    const kinds = new Set(SEQUENCES.flatMap((m) => m().envelopes.map((e) => e.kind)));
    expect([...kinds].sort()).toEqual([
      "hook",
      "liveness",
      "probe",
      "statusline",
      "subagents",
      "transcript",
    ]);
  });

  it("golden session state sequence matches golden-session.timeline.json", async () => {
    const tl = readJson("sessions/golden-session.timeline.json") as unknown as {
      events: number;
      changes: { index: number; from: string; to: string; state_detail: string | null }[];
      final: {
        state: string;
        state_since_index: number;
        ended_reason: string | null;
        compactions: number;
        tasks: unknown;
        model_id: string;
        tracking: unknown;
        subagents: { agent_type: string; started_index: number; ended_index: number | null }[];
      };
    };
    const seq = goldenSession();
    expect(seq.envelopes).toHaveLength(tl.events);
    const h = await makeHub();
    hub = h;
    const seen: { index: number; from: string; to: string; state_detail: string | null }[] = [];
    let prev = "starting";
    let snap: SessionSnapshot | undefined;
    for (const [i, e] of seq.envelopes.entries()) {
      await h.post(batch([e], seq.host));
      const row = h.store.getSession(e.session_id as string);
      snap = JSON.parse((row as { snapshot: string }).snapshot) as SessionSnapshot;
      if (snap.state !== prev)
        seen.push({ index: i, from: prev, to: snap.state, state_detail: snap.state_detail });
      prev = snap.state;
    }
    expect(seen).toEqual(
      tl.changes.map(({ index, from, to, state_detail }) => ({ index, from, to, state_detail })),
    );
    const s = snap as SessionSnapshot;
    expect(s.state).toBe(tl.final.state);
    expect(s.state_since).toBe(BASE_TS + (tl.final.state_since_index + 1) * STEP_MS);
    expect(s.ended_reason).toBe(tl.final.ended_reason);
    expect(s.compactions).toBe(tl.final.compactions);
    expect(s.tasks).toEqual(tl.final.tasks);
    expect(s.model?.id).toBe(tl.final.model_id);
    expect(s.tracking).toEqual(tl.final.tracking);
    expect(s.subagents.map((a) => a.agent_type)).toEqual(
      tl.final.subagents.map((a) => a.agent_type),
    );
    expect(s.subagents.map((a) => a.ended_at !== null)).toEqual(
      tl.final.subagents.map((a) => a.ended_index !== null),
    );
    expect(dump(h)).toEqual(golden(seq.name));
    // sessions row columns follow the snapshot
    const row = h.store.getSession(s.session_id);
    expect(row).toMatchObject({
      state: "ended",
      ended_at: s.state_since,
      last_event_at: s.last_event_at,
    });
  });
});
