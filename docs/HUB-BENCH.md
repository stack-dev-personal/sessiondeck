# Hub bench

## R2.10 cost comparison vs ccusage 19.0.3

- Date: 2026-10-20T17:22Z. HEAD: 695c605 (branch p2/hub-history).
- Machine: Linux 6.18.33.2-microsoft-standard-WSL2 (sprint container), AMD Ryzen AI 9 465 w/ Radeon 880M (20 logical CPUs), node v22.23.3.
- Reference: ccusage 19.0.3, `/tmp/sd-s4-refs/ccusage-npm/package/dist/index.js`, run as a child with an empty HOME and a fetch shim that serves the LiteLLM URL from the local pricing file (no network). Hub side: cost history routes GET /history/sessions, GET /sessions/:id/cost, GET /history/daily.
- Order modes: `file` (transcript order) and `late` (late-arrival ordering); tolerance 1%; token counts (in, out, cache create, cache read) must match exactly, as must model lists.

### Commands

1. `pnpm -F @sessiondeck/hub exec vitest run --maxWorkers=2 test/usage-cost.test.ts`
   tail: `Test Files 1 passed (1) / Tests 31 passed (31)`
2. `node packages/hub/scripts/ccusage-compare.mjs packages/hub/test/fixtures/transcripts --tz UTC,Asia/Tokyo` (exit 0)
   tail: `PASS: all deltas within tolerance`
3. `node packages/hub/scripts/ccusage-compare.mjs /tmp/sd-s4-real --pricing /tmp/sd-s4-refs/litellm/model_prices_and_context_window.json --tz UTC` (exit 0; /tmp/sd-s4-real was a snapshot copy of the container's real transcripts, deleted afterwards)
   tail: `PASS: all deltas within tolerance`

### Pricing-table provenance

- Fixtures: `packages/hub/test/fixtures/transcripts/pricing.json`, sha256 481f46c9...5ad2e (committed, trimmed).
- Real transcripts: full LiteLLM `model_prices_and_context_window.json`, fetched 2026-10-20T16:43Z, sha256 5a5243a53fbe880d84a29dc74865018a0def9deb281ca46a894bae22f6deeed8. Both sides read the same file, so a pricing-version difference cannot arise.

### Aggregates

| Data | tz | order | Sessions (rows) | Days | ccusage USD | hub USD | max session delta % | max day delta % | token deltas (in/out/cc/cr) | model lists |
|---|---|---|---|---|---|---|---|---|---|---|
| Fixtures (3 sessions) | UTC, Asia/Tokyo | file, late (4 runs) | 3 | 4 (per-session costs 0.085251, 2.003925, 0.002025; day costs 1.976385, 0.100551, 0.012240, 0.002025) | 2.091201 | 2.091201 | 0.000000 | 0.000000 | 0 | same on all rows, 0 DIFF |
| Real (container transcripts, 58 jsonl files incl. subagents) | UTC | file | 5 | 1 | 25.502192 (day 25.502193) | 25.502192 (day 25.502193) | 0.000000 | 0.000000 | 0 | same |
| Real | UTC | late | 5 | 1 | 25.502192 | 25.502192 | 0.000000 | 0.000000 | 0 | same |

The per-session table was compared both against /history/sessions and /sessions/:id/cost; both equal ccusage. Session ids and project paths from the real data are not recorded.

### Models in the real transcripts

| Model id | Priced in table | Note |
|---|---|---|
| claude-opus-5-5 | yes (input 4e-6, output 2e-5 per token) | non-zero, real comparison |
| claude-sonnet-5-5 | yes (input 2e-6, output 1e-5 per token) | non-zero, real comparison |

No model priced at 0 or absent from the table, so no row matches trivially.

## R2.9 replay bench

- Date: 2026-10-20. HEAD d02c41e (branch p2/hub-history).
- Machine: this Linux container on WSL2 (Linux 6.18.33.2-microsoft-standard-WSL2), node v22.23.3, AMD Ryzen AI 9 465 w/ Radeon 880M, 20 logical CPUs, 20 GB RAM. The laptop number is to be confirmed by the user.
- Command: `cd packages/hub && node scripts/bench-replay.mjs` (defaults: `--dir /tmp/sd-1-S4-bench --events 1020000 --sessions 300`). The DB was deleted after the run.

Output tail:

```
generate: events=1020000 (generated 1020000, accepted 1020000) avg_payload=898 B elapsed=66 s
--- bench-replay ---
events:           1020000
sessions:         300
hosts:            2
samples:          122655
db size:          1645.6 MB
replay elapsed:   12690 ms (12.7 s)  target < 60000 ms: PASS
replay events/s:  80378
replay peak RSS:  170.0 MB
replay reducer exceptions: 0
compact (cutoff 15 d): 528794 events in 5288 batches, 34199 ms, p50 2.79 ms, p99 43.35 ms, max batch 578.33 ms
compact event-loop: max timer lag 577.45 ms, histogram max 578.81 ms, peak RSS 138.1 MB
```

| Metric | Value | Threshold |
|---|---|---|
| Events | 1,020,000 | >= 1,000,000 |
| Sessions / hosts | 300 / 2 | >= 300 / >= 2 |
| DB size | 1645.6 MB | none |
| Replay elapsed | 12.69 s (80,378 events/s) | < 60 s |
| Replay peak RSS | 170.0 MB | none |
| Reducer exceptions | 0 | 0 |
| Compaction (cutoff 15 d) | 528,794 events, 5,288 batches, p50 2.79 ms, p99 43.35 ms, max 578.33 ms | none stated |

Definition of typical volume (from the header of packages/hub/scripts/bench-replay.ts): 2 hosts, 300 sessions (150 per host), 3,400 envelopes per session = 1,020,000 events spread over 30 days (about 34,000/day, 0.4/s average; bursts of 5-20/s with idle gaps, per the phase doc). Mix per session: 80% hook (golden session's non-lifecycle hooks cycled), 12% statusline (20 captured fixtures cycled), 3% liveness, 5% transcript (5 lines of 400-800 bytes); every session has a SessionStart and SessionEnd. Payloads are the captured fixtures' (avg 898 B here). The work-unit floor is 1,000,000 events across at least 2 hosts and 300 sessions.

Note: compaction max batch is 578 ms (event-loop lag 577 ms), a stall on the hub if compaction runs on the serving process; no threshold is stated for it.
