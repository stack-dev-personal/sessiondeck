/**
 * Writes test/golden/<sequence>.json. The oracle folds the fixture envelopes through the contract
 * reducer functions directly (reduce, reduceLiveness, supersedeSamePid, createSnapshot), without
 * the hub's Store, Ingestor or HTTP layer. Only statusline and subagents envelopes use the hub's
 * pure functions (applyStatusLine, applySubagents): the contract has no reducer for them.
 *
 * Run: pnpm -F @sessiondeck/hub gen:golden
 */
import {
  createSnapshot,
  reduce,
  reduceLiveness,
  supersedeSamePid,
  type Envelope,
  type SessionSnapshot,
} from "@sessiondeck/contract";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SampleRow } from "../src/db/store.ts";
import { applyStatusLine, applySubagents, parseTranscriptPayload } from "../src/ingest/reduce.ts";
import { HUB_ROOT, SEQUENCES, type Seq } from "../test/support/sequences.ts";

export interface Golden {
  snapshots: Record<string, SessionSnapshot>;
  samples: SampleRow[];
  transcript_lines: {
    session_id: string;
    agent_id: string;
    line_no: number;
    ts: number;
    raw: string;
  }[];
}

export function oracle(seq: Seq): Golden {
  const snaps = new Map<string, SessionSnapshot>();
  const samples: SampleRow[] = [];
  const lines: Golden["transcript_lines"] = [];
  const supersede = (s: SessionSnapshot, ts: number) => {
    if (s.pid === null) return;
    const all = [...snaps.values()].filter((x) => x.host === s.host);
    for (const n of supersedeSamePid(all, {
      host: s.host,
      session_id: s.session_id,
      pid: s.pid,
      ts,
    })) {
      snaps.set(n.session_id, n);
    }
  };
  for (const e of seq.envelopes as Envelope[]) {
    if (e.session_id === null) continue;
    const id = e.session_id;
    const cwd = (e.payload as { cwd?: unknown } | null)?.cwd;
    const prev =
      snaps.get(id) ??
      createSnapshot({
        session_id: id,
        host: e.host,
        cwd: typeof cwd === "string" ? cwd : "",
        ts: e.ts,
      });
    if (e.kind === "hook") {
      const next = reduce(prev, e as Envelope<"hook">);
      snaps.set(id, next);
      if (e.hook_event_name === "SessionStart") supersede(next, e.ts);
    } else if (e.kind === "liveness") {
      const next = reduceLiveness(prev, e as Envelope<"liveness">);
      snaps.set(id, next);
      if (next.pid !== prev.pid) supersede(next, e.ts);
    } else if (e.kind === "statusline") {
      const r = applyStatusLine(prev, e, () => undefined);
      snaps.set(id, r.snapshot);
      if (r.sample !== null) samples.push(r.sample);
    } else if (e.kind === "subagents") {
      snaps.set(id, applySubagents(prev, e));
    } else if (e.kind === "transcript") {
      for (const l of parseTranscriptPayload(e.payload)) {
        lines.push({
          session_id: id,
          agent_id: e.agent_id ?? "",
          line_no: l.line_no,
          ts: e.ts,
          raw: l.raw,
        });
      }
    }
  }
  const snapshots: Record<string, SessionSnapshot> = {};
  for (const k of [...snaps.keys()].sort()) snapshots[k] = snaps.get(k) as SessionSnapshot;
  samples.sort((a, b) =>
    a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : a.ts - b.ts,
  );
  lines.sort((a, b) =>
    a.session_id !== b.session_id
      ? a.session_id < b.session_id
        ? -1
        : 1
      : a.agent_id !== b.agent_id
        ? a.agent_id < b.agent_id
          ? -1
          : 1
        : a.line_no - b.line_no,
  );
  return { snapshots, samples, transcript_lines: lines };
}

if (process.argv[1] !== undefined && path.basename(process.argv[1]) === "gen-golden.mjs") {
  const dir = path.resolve(HUB_ROOT, "test/golden");
  mkdirSync(dir, { recursive: true });
  for (const make of SEQUENCES) {
    const seq = make();
    writeFileSync(path.join(dir, `${seq.name}.json`), `${JSON.stringify(oracle(seq), null, 2)}\n`);
    console.log(`wrote ${seq.name}: ${seq.envelopes.length} envelopes`);
  }
}
