// R2.12. Replay's counterpart of the live derivation: after the events are folded, every session's
// snapshot is re-derived from the stored transcript lines with the same functions ingest uses
// (TranscriptDeriver.rebuild, applyFigures, applyCost), so a replay yields the snapshot ingest
// produced. Cost needs the global dedup of the usage index, so one UsageCollector is built from
// all stored usage lines, but only when some session still lacks a statusline cost.
import type { SessionSnapshot } from "@sessiondeck/contract";
import type { Store } from "../db/store.ts";
import type { PricingTable } from "../pricing/pricing.ts";
import { UsageCollector } from "../usage/usage.ts";
import { applyCost, applyFigures, applySubagentFigures, needsSubagentFigures } from "./apply.ts";
import { TranscriptDeriver, type DeriverLog } from "./deriver.ts";

const USAGE_PAGE = 5000;

function buildUsageIndex(store: Store): UsageCollector {
  const index = new UsageCollector();
  let after = 0;
  for (;;) {
    const batch = store.listUsageLinesAfter(after, USAGE_PAGE);
    for (const r of batch) {
      if (r.raw === null) continue;
      index.addRow({
        session_id: r.session_id,
        agent_id: r.agent_id,
        line_no: r.line_no,
        project_dir: r.project_dir,
        raw: r.raw,
      });
    }
    const last = batch.at(-1);
    if (last === undefined || batch.length < USAGE_PAGE) break;
    after = last.rid;
  }
  return index;
}

/** New snapshots (map keys unchanged) with transcript-derived figures and cost filled. */
export function rederiveFromTranscripts(
  store: Store,
  log: DeriverLog,
  snapshots: ReadonlyMap<string, SessionSnapshot>,
  pricing: PricingTable,
): Map<string, SessionSnapshot> {
  const deriver = new TranscriptDeriver(store, log);
  const out = new Map<string, SessionSnapshot>();
  for (const [id, snap] of snapshots) {
    // Replay is offline: scan every stored line (no ingest cap), so it agrees with the live fold.
    let next = applyFigures(snap, deriver.rebuild(id, "", Number.POSITIVE_INFINITY));
    for (const row of snap.subagents) {
      if (!needsSubagentFigures(row)) continue;
      const f = deriver.rebuild(id, row.agent_id, Number.POSITIVE_INFINITY);
      next = applySubagentFigures(next, row.agent_id, f);
    }
    out.set(id, next);
  }
  const needCost = [...out.values()].some((s) => s.sources?.cost !== "statusline");
  if (!needCost) return out;
  const index = buildUsageIndex(store);
  for (const [id, snap] of out) {
    if (snap.sources?.cost === "statusline") continue;
    const found = index.sessions(pricing, undefined, id)[0];
    if (found !== undefined) out.set(id, applyCost(snap, found.cost_usd));
  }
  return out;
}
