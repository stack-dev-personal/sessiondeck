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

Re-run at HEAD e25cef3 (2026-10-21T00:05Z, same machine, same command): replay 8.70 s (117,228 events/s), peak RSS 169.2 MB, DB 1627.3 MB, 0 reducer exceptions; compaction (cutoff 15 d) 528,718 events, 5,288 batches, 25.3 s, p50 1.07 ms, p99 12.12 ms, max batch 29.02 ms, max timer lag 38.67 ms. Faster than the table above after the compaction pacing and generator changes; still PASS against < 60 s.

Definition of typical volume (from the header of packages/hub/scripts/bench-replay.ts): 2 hosts, 300 sessions (150 per host), 3,400 envelopes per session = 1,020,000 events spread over 30 days (about 34,000/day, 0.4/s average; bursts of 5-20/s with idle gaps, per the phase doc). Mix per session: 80% hook (golden session's non-lifecycle hooks cycled), 12% statusline (20 captured fixtures cycled), 3% liveness, 5% transcript (5 lines of 400-800 bytes); every session has a SessionStart and SessionEnd. Payloads are the captured fixtures' (avg 898 B here). The work-unit floor is 1,000,000 events across at least 2 hosts and 300 sessions.

Note: compaction max batch is 578 ms (event-loop lag 577 ms), a stall on the hub if compaction runs on the serving process; no threshold is stated for it.

## R2.4 ingest load

Requirement: "Ingest p95 < 20 ms per batch of 100 at 1k envelopes/s on the laptop." Partial is fail.

- Date: 2026-10-20, 23:46Z to 23:56Z. HEAD: aa80a18 (branch p2/hub-history).
- Environment: Debian 12 in a WSL2 Linux sprint container (kernel 6.18.33.2-microsoft-standard-WSL2) on the laptop's Docker Desktop, AMD Ryzen AI 9 465 w/ Radeon 880M, 20 logical CPUs, 19 GB, node v22.23.3. This is NOT the Windows-native probe host. Other sprint containers share the machine. Runs were sequential, one process at a time, in the foreground.
- Harness: `packages/hub/scripts/load-ingest.mjs`, open loop, latency from scheduled send to end of response. Each run: 709 batches of 100 over 70.8 s, first 5 s (50 batches) is warm-up, 659 batches (65,900 envelopes) measured, all with `--rate 1000 --duration 60 --batch 100 --p95-limit 20`. Default target is an in-process Fastify server with a real SQLite file (WAL, checkpoint 100 ms), client in the same process (can only overstate latency).
- Load avg is the 1-minute `uptime` value before / after the run.

Commands (from the repo root):

1. `pnpm -F @sessiondeck/hub load --rate 1000 --duration 60 --batch 100 --p95-limit 20 --verify-live`
2. same flags with `--with-retention` instead of `--verify-live` (default backlog: 599,984 events older than the window), three times
3. same flags with `--hot-session`
4. `HUB_ENV_FILE=<scratch env file> SD_HUB_PUBLISH_PORT=18787 docker compose -p sd-1-s4 -f infra/docker-compose.yml up -d --build hub`, then the same flags plus `--verify-live --url http://172.27.0.2:8787 --token-file <scratch file> --allow-insecure` (container IP; token in a mode 600 scratch file, never printed); then `docker compose -p sd-1-s4 -f infra/docker-compose.yml down -v` and scratch files removed.

| Run | p50 ms | p95 ms | p99 ms | max ms | requests (measured) | failures | load avg before / after | Result |
|---|---|---|---|---|---|---|---|---|
| 1 Sustained, `--verify-live` | 8.20 | 10.91 | 11.82 | 13.82 | 659 | 0 | 0.35 / 0.13 | PASS |
| 2a `--with-retention` run 1 | 7.97 | 11.30 | 12.43 | 19.86 | 659 | 0 | 0.13 / 0.48 | PASS |
| ... during compaction (405 batches) | 6.73 | 10.31 | 11.66 | 19.86 | 405 | 0 | | |
| ... outside compaction (254) | 8.67 | 11.84 | 12.92 | 14.16 | 254 | 0 | | |
| 2b `--with-retention` run 2 | 7.72 | 11.23 | 12.73 | 20.24 | 659 | 0 | 0.48 / 0.43 | PASS |
| ... during compaction (439) | 6.89 | 10.48 | 12.73 | 20.24 | 439 | 0 | | |
| ... outside compaction (220) | 8.72 | 11.63 | 12.63 | 14.31 | 220 | 0 | | |
| 2c `--with-retention` run 3 | 7.86 | 11.68 | 14.55 | 21.39 | 659 | 0 | 0.43 / 0.52 | PASS |
| ... during compaction (391) | 7.59 | 11.39 | 15.00 | 21.39 | 391 | 0 | | |
| ... outside compaction (268) | 8.09 | 11.71 | 13.33 | 14.68 | 268 | 0 | | |
| 3 `--hot-session` (one session_id) | 9.68 | 12.76 | 15.23 | 29.79 | 659 | 0 | 0.56 / 0.68 | PASS |
| 4 Containerized hub (compose, container IP), `--verify-live` | 9.03 | 12.89 | 17.24 | 19.38 | 659 | 0 | 2.64 / 2.66 | PASS |

Compaction in runs 2a to 2c: 599,984 events in 6000 batches, 40.4 s / 43.8 s / 39.0 s (14.8k, 13.7k, 15.4k events/s), compaction batch max 21.97 / 14.84 / 15.92 ms, 0 forced batches, 0 old events left. Achieved rate 1001 envelopes/s in every run. All 659 measured batches ok in every run; no errors by status; the in-process hub logged 0 warn/error in runs 1 and 2.

Notes:

- Run 3: the hub log shows many "statusline for another host ignored" warnings (4,236 warn/error lines). That is an artifact of sending both synthetic hosts under one session_id (a statusLine from the second host is ignored); not an ingest failure. All 70,900 envelopes were accepted.
- Run 4: the host 1-minute load was 2.64 at the start because the image build and container start had just run (above the 1.5 threshold). The run passed, so no rerun was triggered by the rule; the number is therefore recorded as taken under some host load, and it is the highest p95 of the five, but still well under the limit. The container log had 0 warn/error lines.
- `--verify-live`: 116 sessions live of 119 created, the expected value (3 ended under 10 min before the check).
- Margin: worst p95 is 12.89 ms against 20 ms (about 36% headroom). Worst single batch is 29.79 ms (hot session), which is a max, not a p95.

Verdict: R2.4 PASS in this environment on all five runs (p95 10.91 to 12.89 ms, 0 failures, 1k envelopes/s sustained, including during compaction, with a hot session, and against the containerized hub over the network path). Laptop-native confirmation (Windows host, Docker Desktop or a hub run natively) is still advisable: this is a Linux VM on the laptop sharing CPUs with other containers, and the Windows filesystem and antivirus behavior of the real deployment are not exercised. A pass here is a strong indication, not a measurement of the target host.

## FIX-5 (R2.4 at HEAD dbb1e33)

Machine: Debian 12 (WSL2 kernel 6.18.33.2-microsoft-standard-WSL2), AMD Ryzen AI 9 465 w/ Radeon 880M, 20 logical CPUs, 20 GB RAM, node v22.23.3. Shared host: other sessions were running (load average 3.29 before, 1.45 after my run).

Command: `pnpm -F @sessiondeck/hub load --rate 1000 --duration 60 --batch 100 --p95-limit 20`

| Run | Revision | p50 ms | p95 ms | p99 ms | max ms | Result |
|---|---|---|---|---|---|---|
| verifier, 2026-10-21T18:41Z | dbb1e33 | 16.01 | 32.41 | 41.33 | 50.90 | FAIL (limit 20) |
| orchestrator 1 | 0e321fe | 13.69 | 28.46 | 39.21 | 77.06 | FAIL |
| orchestrator 2 | 0e321fe | 11.45 | 20.56 | 25.60 | 30.77 | FAIL |
| orchestrator 3 | 0e321fe | 12.29 | 25.85 | 41.92 | 177.35 | FAIL |
| orchestrator 1 | dbb1e33 | 14.52 | 47.89 | 185.69 | 298.02 | FAIL |
| orchestrator 2 | dbb1e33 | 11.77 | 163.64 | 2635.53 | 3167.53 | FAIL |
| orchestrator 3 | dbb1e33 | 11.34 | 22.54 | 36.80 | 54.74 | FAIL |

`git log 0e321fe..HEAD -- packages/hub packages/contract` is empty and hub's resolved dependencies are identical, so there is no regression versus 0e321fe; the failures are host contention. Earlier clean-host runs in this file passed (p95 10.91 to 12.89 ms). Verdict for FIX-5: R2.4 fail on this host, needs-laptop-confirmation. Raw: /state/1/gate/FIX-5/verify-load-HEAD.txt, f3-load-*.log.

## U2 fix iteration 1 (R2.12 against R2.4 and R2.9)

Date 2026-10-28, branch p2/headless-metrics. Machine: Windows 11 native (not WSL, not a container), node v24.19.0 (the hub requires >=22.6), the laptop at about 96% total CPU from Docker Desktop and other sprint containers throughout (ten containers up, Task Manager busy). These are not quiet-host numbers. The claim is no regression versus the baseline under the same load, not an absolute R2.4 pass: every run below exceeds 20 ms, before and after.

Harness change (commit 625883f, same for both columns): `scripts/synth-spool.ts` transcript envelopes are now real assistant rows (text block, unique `message.id`, model, `usage`, `gitBranch`), and odd-numbered sessions are headless (no statusline). Before, the lines were `{n,text}`, so neither the deriver, the usage index nor `CostFiller` ran in `load` or `bench-replay`. Now each 100-envelope batch carries about 5 transcript envelopes of 5 usage rows.

### R2.4 ingest load

Command: `cd packages/hub && node scripts/load-ingest.mjs --rate 1000 --duration 60` (batch 100, 5 s warm-up, 659 batches measured, in-process Fastify plus SQLite WAL, client in the same process). Three runs per column, sequential, nothing else of mine running. "Before" is the source at 625883f (`git checkout 625883f -- packages/hub/src`), "after" is HEAD of this fix. Both columns measured back to back in one session.

| Column | Run | p50 ms | p95 ms | p99 ms | max ms | failures |
|---|---|---|---|---|---|---|
| before (first set) | 1 | 156.61 | 433.10 | 570.94 | 890.56 | 0 |
| before (first set) | 2 | 138.67 | 262.94 | 321.76 | 554.29 | 0 |
| before (first set) | 3 | 168.52 | 625.48 | 851.14 | 1053.62 | 0 |
| before (rerun, adjacent to after) | 1 | 99.13 | 326.77 | 602.10 | 826.40 | 0 |
| before (rerun, adjacent to after) | 2 | 85.63 | 6596.39 | 8142.92 | 8740.65 | 0 |
| before (rerun, adjacent to after) | 3 | 831.32 | 3587.56 | 4300.90 | 4699.48 | 0 |
| after | 1 | 29.63 | 162.93 | 342.05 | 626.40 | 0 |
| after | 2 | 26.92 | 106.92 | 237.28 | 513.88 | 0 |
| after | 3 | 29.80 | 141.31 | 1392.64 | 1792.24 | 0 |

Result: median p50 27 to 30 ms after against 86 to 832 ms before; median p95 141 ms after against 327 to 433 ms before (worst before 6.6 s). No regression; the debounce and the per-session yield remove the per-batch usage refresh and re-sum from the request path. R2.4 itself (p95 < 20 ms) is NOT demonstrated here: it needs a quiet host (laptop confirmation still outstanding, as in FIX-5). An intermediate set (patch 1 only, before the final code) gave p95 299, 688, 174 ms with a second harness process possibly overlapping; discarded.

### R2.9 replay

Command: `cd packages/hub && node scripts/bench-replay.mjs --dir /tmp/sd-2-S8d-bench4` (1,020,000 events, 300 sessions, 2 hosts; 5% of envelopes are transcript envelopes with usage rows; half of the sessions are headless and so need the usage index at replay).

| Column | replay elapsed | events/s | peak RSS | exceptions |
|---|---|---|---|---|
| before (625883f source, new synth) | 52,892 ms | 19,285 | 333.5 MB | 0 |
| after (HEAD) | 53,576 ms | 19,038 | 339.0 MB | 0 |

Result: PASS (< 60 s) with a thin margin on a loaded host; unchanged by this iteration (the scan bound does not bite on the synthetic sessions). The earlier 12.7 s figure (HEAD d02c41e, Linux, no transcript-derived work, idle host) is not comparable: the replay now also builds the usage index and re-derives every session, and the host is busy. A quiet-host re-run is advisable before closing R2.9. Compaction in the same run: 528,150 events, p99 batch 92.56 ms, max batch 204.73 ms.

## U3 fix iteration 1 (R2.9 stress mix)

Date 2026-10-28, branch p2/headless-metrics, HEAD d682ff6 plus the bench-only synth change (replay full scan: sessions never complete, effort now part of the subagent completeness test). Machine: Windows 11 native, node v24.19.0, 20 containers up, total CPU 64 to 71% at start (not a quiet host).

New option `--stress` on `bench-replay` and `load-ingest` (synth-spool `stress: true`): every 4th session (75 of 300) is branchless and text-free (assistant rows are tool_use only, no `gitBranch`), and every other transcript envelope of those sessions is a subagent transcript (agent_id of the golden SubagentStart, sidechain rows, no effort), so those sessions' main and subagent figures never complete and replay scans every stored line. The default mix is unchanged (same random sequence).

Command: `cd packages/hub && node scripts/bench-replay.mjs --dir /tmp/sd-2-S8d-bench5 --stress` (same base args as the R2.9 row above: 1,020,000 events, 300 sessions, 2 hosts).

| Column | replay elapsed | events/s | peak RSS | exceptions |
|---|---|---|---|---|
| stress mix, HEAD | 14,217 ms | 71,745 | 342.4 MB | 0 |

Result: PASS (< 60 s). The earlier 53.6 s row was taken at about 96% CPU, this one at 64 to 71%, so the two are not comparable; no default-mix rerun was made (one run only, per the unit). The full scan is cheap: a `"gitBranch":` substring test skips the branch regex, and JSON parse happens only for lines containing `"type":"assistant"`. Compaction in the same run: 528,083 events, p99 batch 42.4 ms, max batch 332.08 ms. The R2.4 load bench with `--stress` (subagent lines inside the ingest transaction) is NOT run; the quiet-host run stays deferred.
