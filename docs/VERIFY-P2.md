# Verification, Phase 2 (hub), S3 scope

- Branch: p2/hub-core, HEAD ad73c91. Gates and R0.5 re-run at this commit. R2.x rows were verified at 416b3ca and the hub is unchanged since (`git diff 416b3ca HEAD -- packages/hub` empty; U8 ad73c91 touched only packages/contract/test/state-file-cli-merge.test.ts and state-file-lock.test.ts); hub src unchanged since 7425f9e, U7 changed only hub test helpers, migrations.test.ts and vitest.config.ts; earlier per-commit evidence is superseded (see git history of this file).
- Run: R2.x 2026-10-20T16:16Z to 16:30Z; gates and R0.5 re-run after 16:31Z (UTC). Machine: Linux 6.18.33.2-microsoft-standard-WSL2 (sprint container), AMD Ryzen AI 9 465 w/ Radeon 880M, node v22.23.3, Docker available.
- Scope: R2.1, R2.2, R2.3, R2.5, R2.6, R2.7, R2.8, plus R0.5 CI evidence. R2.4 and R2.10 (compose) are S4 and not verified here.

## Repo-wide gates (from repo root)

| Command | Evidence | Verdict |
|---|---|---|
| `pnpm -r test` | exit 0, 8.3 s wall at ad73c91. contract: 28 files, 1090 passed, 1 skipped. scripts: 28 files passed, 1 skipped, 575 passed, 7 skipped. hub: 15 files, 177 passed, 0 failed. | pass |
| `pnpm -r typecheck` | exit 0. contract, hub, scripts: tsc --noEmit, no errors. | pass |
| `pnpm -r lint` | exit 0. contract, hub, scripts: eslint, no errors. | pass |

## Requirements

| ID | Command | Evidence | Verdict |
|---|---|---|---|
| R2.1 Ingest rejects malformed envelopes with 400 and a reason; accepts batches up to 1 MB | `pnpm -F @sessiondeck/hub test` (15 files, 177 passed) | ingest-validation.test.ts 14 passed ("R2.1 validation": exactly 1 MiB accepted, 1 byte more is 413); ingest-hardening.test.ts 30 passed ("D-S3-8 bounds": 5001 envelopes 400, 5000 passes) | pass |
| R2.2 Duplicate id or identical signature within 5 s accepted but not stored twice | same | ingest-dedup.test.ts 10 passed (same id, same (host, seq), signature 4.9 s vs 5.1 s); container re-POST of 817 envelopes accepted 0 | pass |
| R2.3 Replaying Phase 0 fixtures yields snapshots equal to golden files | same | ingest-golden.test.ts 25 passed ("R2.3 golden replay over HTTP", 5 golden files, timeline match). See note 1: the batch-size x mode matrix was reduced after fab329c (52 to 25 tests); every golden file still replays in plain, interleaved-dups and resent-after modes and each is compared to the golden file. | pass |
| R2.5 WS initial plus every delta, exactly once, each within 100 ms; reconnect resyncs | `node packages/hub/scripts/ws-harness.mjs` and stream.test.ts (20 tests) | in-process, 5 clients: fan-out 200 deltas, p50 0.97 p95 2.17 max 27.88 ms (gate 100), dup 0, missing 0, PASS; reconnect 20 deltas dup 0 missing 0, stale in new initial 0, replayed old deltas 0, PASS; exit 0. Against the container (smoke): p50 1.15 p95 2.12 max 20.44 ms, dup 0, missing 0, PASS. Max varies run to run (29.49, 82.54, 72.16 ms seen across runs); worst observed is 17.5 ms under the gate. | pass |
| R2.6 `GET /sessions?live=1` excludes ended/exited older than 10 min | hub tests | read-routes.test.ts 19 passed ("R2.6 GET /sessions?live=1"); stream.test.ts "D-S3-12" REST/WS agreement; container smoke: `?live=1` returned 14 sessions | pass |
| R2.7 Rate-limit windows past resets_at are null; used_percentage outside 0..100 nulled and logged | hub tests | read-routes.test.ts "R2.7 read-time staleness on REST"; stream.test.ts "R2.7 staleness over WS"; ingest-reduce.test.ts (14) "R2.7: used_percentage -5 and 140 are nulled and logged" | pass |
| R2.8 Bearer token on every route except /health; 401 with empty body | hub tests and `node packages/hub/scripts/container-smoke.mjs` | auth.test.ts 13 passed; read-routes "R2.8 on the new REST routes"; stream.test.ts "R2.8 WS upgrade authentication"; read-limit.test.ts 7 passed. Container: /health 200, no-token and wrong-token 401 with content-length 0, WS upgrade no token 401, with token 101. | pass |
| R2.8 container (ingest replayed fixtures, live sessions, restart persistence, canary) | `node packages/hub/scripts/container-smoke.mjs` (exit 0, "SMOKE PASS") | image sd-1-s3-hub:dev built with legacy builder, canary files absent from image; fixtures replayed over 5 sequences; live sessions reconstructed (14); golden session present (ended); re-POST accepted 0; restart healthy again in 262 ms, 14 sessions and live view persist, dedup survives; PID 1 uid 10001; DB mode 0600; /data owner 10001; docker HEALTHCHECK healthy. Script removed container sd-1-S3-hub and volume sd-1-S3-hubdata; afterwards no sd-1-S3-* container or volume remained (only the image tag sd-1-s3-hub:dev stays). arm64 build skipped (no buildx or qemu binfmt); not part of R2.1 to R2.8. | pass |
| R0.5 `pnpm -r test` inside 60 s budget on the CI matrix | `gh run view 39457486239 --json jobs` (pull_request) and `39457476643` (push), both HEAD ad73c91 | all four jobs success in both runs (ubuntu-latest and windows-latest, node 22 and 24). Step "test (R0.5 budget 60 s)" on Windows: PR run node 22 41 s (16:28:15Z to 16:28:56Z), node 24 35 s; push run node 22 25 s, node 24 35 s. Ubuntu 18 to 25 s. Worst Windows 41 s, headroom 19 s. Local Linux run 8.3 s. See notes 2 and 5. | pass |
| R2.4 | not in S3 scope | | S4 |
| R2.10 (compose) | not in S3 scope | | S4 |

## Notes

1. Test count moved from 204 (at fab329c) to 177 (unchanged at 416b3ca). The change is in commits f6b9603 and b6d6133, which trimmed redundant cells of the R2.3 golden batch-size x mode matrix (52 to 25 tests) to fit the R0.5 budget on Windows, and added a full-golden comparison to the golden-session timeline test. Coverage is narrowed but each golden file is still compared in three modes; the reviewer may judge whether that is enough.
2. After U7 (in-memory test stores, isolate:false, maxWorkers 2) the Windows R0.5 step is 36 to 41 s, down from 49 to 52 s at 7425f9e; headroom is now 19 s or more.
3. The ws-harness runs the hub in-process; the container run covers the real network path. Harness maximum latency is noisy and has reached 82.54 ms against the 100 ms gate in one earlier run.
4. Not re-run in this pass: the no-outbound-network grep of packages/hub/src and the live curl checks recorded in earlier versions of this file; the hub src is unchanged since fab329c except tests and vitest config (`git diff fab329c HEAD -- packages/hub` touches only test files and vitest.config.ts).
5. The earlier PR run 39456320083 (HEAD ea03c31) failed: windows-latest node 22, R0.5 step, packages/contract state-file-cli-merge.test.ts "reports a lock that stays held, without sleeping for real" timed out at 5000 ms (200 fs-bound poll rounds). U8 (ad73c91) passes pollMs 1000 in the two contract lock tests; the same matrix is green at ad73c91 (runs above). The ea03c31 failure is a contract test timeout, not a hub failure.
6. At ad73c91 `pnpm -r test` was run twice in sequence (second only to capture counts), both exit 0, same counts; `pnpm -r lint` exit 0.

## S4 (p2/hub-history)

- Branch p2/hub-history, HEAD 695c605. Run 2026-10-20T17:22Z. Machine and node as in docs/HUB-BENCH.md.

| ID | Command | Evidence | Verdict |
|---|---|---|---|
| R2.10 Cost history per session and per day matches ccusage `session` output for the same transcripts within 1% | `pnpm -F @sessiondeck/hub exec vitest run --maxWorkers=2 test/usage-cost.test.ts`; `node packages/hub/scripts/ccusage-compare.mjs packages/hub/test/fixtures/transcripts --tz UTC,Asia/Tokyo`; same harness on a snapshot of real transcripts with the full LiteLLM table (sha256 5a5243a5...eed8), UTC | vitest 31 passed. Fixtures: 4 runs (UTC and Tokyo, file and late order), every row ok, max delta 0.000000%, token deltas 0, "PASS: all deltas within tolerance". Real: 5 sessions, 1 day, ccusage 25.502192 USD vs hub 25.502192, max delta 0.000000% (session and day), token deltas 0, both order modes, PASS; models claude-opus-5-5 and claude-sonnet-5-5 both priced non-zero. Details in docs/HUB-BENCH.md section "R2.10 cost comparison vs ccusage 19.0.3". Caveat: real data is one UTC day, so day-bucket coverage on real data is thin; the fixtures cover 4 days and two time zones. | pass |
| R2.9 `hub replay` rebuilds all snapshots from events in under 60 s for 30 days of your typical volume | `cd packages/hub && node scripts/bench-replay.mjs` (defaults), HEAD d02c41e, 2026-10-20, Linux container on WSL2 | events=1020000, sessions=300, hosts=2, DB 1645.6 MB; `replay elapsed: 12690 ms (12.7 s)  target < 60000 ms: PASS`; 80378 events/s; peak RSS 170.0 MB; reducer exceptions 0. Typical volume definition and compaction numbers in docs/HUB-BENCH.md section "R2.9 replay bench". Caveat: measured in the container, not on the laptop; laptop number to be confirmed by the user. | pass |
| Scope: retention + replay (events older than 30 days compacted to snapshots, configurable; replay command) | `pnpm -F @sessiondeck/hub exec vitest run --maxWorkers=2 test/replay.test.ts test/replay-review.test.ts test/ingest-golden.test.ts`; CLI: `pnpm -F @sessiondeck/hub replay --db <tmp>` and `compact --db <tmp>` on a 6000-event temp DB | vitest 3 files, 73 passed (33 + 15 + 25). CLI: `replay: sessions=10 events=2400 samples=258 elapsed_ms=126 reducer_exceptions=0` (events=2400 because the bench had already compacted 3600 at a 15 d cutoff); `compact: events=0 batches=0 sessions=0 samples_deleted=4 elapsed_ms=1 max_batch_ms=0 reducer_exceptions=0` (nothing left to compact). Note: `pnpm ... replay -- --db` fails with exit 2; use `replay --db <path>` without `--`. Compaction of 528,794 events on the 1M DB is in the bench section. | pass |
| R2.4 "Ingest p95 < 20 ms per batch of 100 at 1k envelopes/s on the laptop." | `pnpm -F @sessiondeck/hub load --rate 1000 --duration 60 --batch 100 --p95-limit 20` with `--verify-live`; with `--with-retention` (x3, 600k backlog); with `--hot-session`; and against the compose hub (`--url http://<container-ip>:8787 --token-file ... --allow-insecure`). HEAD aa80a18, 2026-10-20T23:46Z to 23:56Z, WSL2 Linux container (not the Windows host) | Sustained: `p50 8.20 p95 10.91 p99 11.82 max 13.82`, 659 batches ok, `R2.4 ingest p95 < 20 ms per batch of 100: PASS (p95 10.91 ms)`. Retention x3: p95 11.30 / 11.23 / 11.68 (during compaction 10.31 / 10.48 / 11.39), max 19.86 to 21.39, 0 failures. Hot session: p95 12.76, max 29.79. Container: p95 12.89, max 19.38, 0 failures (host load 2.64 at start, passed). All exit 0, 1001 envelopes/s achieved. Full table in docs/HUB-BENCH.md section "R2.4 ingest load". Caveat: not the Windows-native host; laptop-native confirmation still advisable. | pass |

### S4 session close (HEAD e25cef3, run 2026-10-20T23:57Z to 2026-10-21T00:32Z)

Machine and node as in docs/HUB-BENCH.md. One test process at a time, `--maxWorkers=2`, per-package sequential (`--workspace-concurrency=1`). Verifier: sd-verifier run by the session-close pass; nothing was fixed in this pass.

| ID / check | Command | Evidence | Verdict |
|---|---|---|---|
| Suite: tests | `pnpm -r --workspace-concurrency=1 test -- --maxWorkers=2` | exit 0. contract 28 files, 1090 passed, 1 skipped; scripts 21 files, 281 passed; hub 28 files passed + 1 skipped, 575 passed, 7 skipped (the hub package printed its summary twice in the log; same counts). | pass |
| Suite: typecheck | `pnpm -r --workspace-concurrency=1 typecheck` | exit 0 (`tsc --noEmit` x3) | pass |
| Suite: lint | `pnpm -r --workspace-concurrency=1 lint` | exit 0 (`eslint .` x3) | pass |
| R2.10 at HEAD | `pnpm -F @sessiondeck/hub exec vitest run --maxWorkers=2 test/usage-cost.test.ts`; `node packages/hub/scripts/ccusage-compare.mjs packages/hub/test/fixtures/transcripts --tz UTC,Asia/Tokyo` | vitest 31 passed. Fixtures: 3 sessions, 4 days, every row ok, max delta 0.000000%, token deltas 0, "PASS: all deltas within tolerance". Same numbers as the 695c605 run. The ccusage 19.0.3 reference under /tmp had been cleaned up; re-fetched with `npm pack ccusage@19.0.3` into /tmp/sd-s4-refs/ccusage-npm (default path of the script). Real-transcript comparison NOT re-run (snapshot and full LiteLLM table were deleted); `git diff 695c605 HEAD -- packages/hub/src` touches no cost/usage/pricing file, so the earlier real-data row (25.502192 vs 25.502192, 0% delta) stands as recorded. | pass |
| R2.9 at HEAD | `cd packages/hub && node scripts/bench-replay.mjs` (defaults) | events=1020000, sessions=300, hosts=2, DB 1627.3 MB, `replay elapsed: 8701 ms (8.7 s)  target < 60000 ms: PASS`, 117228 events/s, peak RSS 169.2 MB, reducer exceptions 0. Earlier: 12.7 s, 80378 events/s. Compaction (cutoff 15 d): 528718 events, 5288 batches, 25314 ms, p50 1.07 ms, p99 12.12 ms, max batch 29.02 ms, max timer lag 38.67 ms (earlier max batch 578 ms). Bench DB removed. | pass |
| Integration check 1 (compose hub) | `docker compose -p sd-1-s4 -f infra/docker-compose.yml up -d --build hub` with scratch env file; `node packages/hub/scripts/load-ingest.mjs --speed 10 --events 180000 --span-min 30 --url http://172.27.0.2:8787 --token-file <tmp> --allow-insecure --verify-live` | Host port 127.0.0.1:18787 unreachable from the sprint container, container IP used. Container `sd-1-s4-hub-1` healthy; GET /health 200; no-token GET /sessions 401. Replayed day: 179988 envelopes, 53 sessions, 2 hosts, accepted 179988, duplicates 0, errors none, p95 15.71 ms, 1799 batches ok. `GET /sessions?live=1` -> 200, 6 sessions, matching the expected 6 (ended under 10 min ago); `GET /sessions` returned all 53. `down -v` removed container, volume and network. container-smoke.mjs not re-run (R2.8 row above stands). | pass |
| Compose web (phase-2 DoD: compose runs hub and web static build) | scratch worktree /tmp/sd-1-S4-webproof from HEAD + `git merge origin/p3/board-mock` (0ebe8ee); `docker compose -p sd-1-s4w -f infra/docker-compose.yml up -d --build` | The merge conflicted only in pnpm-lock.yaml (68 hunks); resolved in the scratch tree by taking HEAD's lock and running `pnpm install --lockfile-only`. NOTE for the integrator: merging p3/board-mock after p2/hub-history will conflict on pnpm-lock.yaml; regenerate it. Both images built (web: pnpm install, tsc, vite build). Both containers healthy. GET web `/` -> 200, 414 B `index.html` (`<title>sessiondeck</title>`, `/assets/index-BaK0dY3K.js`), CSP and security headers present; asset 200 (262,977 B); hub `/health` -> 200 `{"ok":true}`. Torn down with `down -v`, worktree removed, nothing pushed. packages/web is not on p2/hub-history, so this is proven on the scratch merge only. | pass |
| R2.4 | rows above (load harness, 2026-10-20T23:46Z); at close, replay-mode load against the compose hub | p95 15.71 ms on the compose hub in replay mode at ~342 envelopes/s (not the 1k/s gate); the 1k/s sustained result (p95 10.91 ms) and the container 1k/s result (p95 12.89 ms) were recorded at aa80a18. Not re-run at e25cef3: the only commit after aa80a18 is docs (`git diff aa80a18 HEAD --stat` shows docs only). Laptop-native confirmation still advisable. | pass |
| Scope: statusline_samples retention / 30-day compaction / replay command | included in the suite above (replay.test.ts, replay-review.test.ts, ingest-golden.test.ts, retention tests) and the bench compaction run | suite green; bench compacted 528718 events and replay rebuilt 300 sessions with 0 reducer exceptions | pass |

Cleanup: no `sd-1-s4*` container, volume or network remains; scratch token and env files deleted. Images `sessiondeck-hub:dev` and `sessiondeck-web:dev` stay in the local image cache.

### S4 re-confirmation at c187737 (run 2026-10-21T01:04Z to 01:06Z)

Commits since e25cef3: f7724f5, 7990481, 9cff0ca (test-only speedups for the Windows R0.5 budget), c187737 (test hardening), 68d3c1f (production: `Store.open` sets `synchronous = NORMAL` explicitly; sd-reviewer showed the effective level was already NORMAL after the first transaction because better-sqlite3 is built with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1).

| Check | Command | Key output | Verdict |
|---|---|---|---|
| Suite (R2.9, R2.10) | `pnpm -r --workspace-concurrency=1 test -- --maxWorkers=2` (single process, foreground; run twice, same result) | hub 28 files, 1090 passed, 1 skipped; contract 21 files, 282 passed; scripts 28 files, 575 passed, 7 skipped (1 file skipped); exit 0 | R2.9 pass, R2.10 pass |
| Typecheck | `pnpm -r typecheck` | contract, hub, scripts Done; exit 0 | pass |
| Lint | `pnpm -r lint` | contract, hub, scripts Done; exit 0 | pass |
| R2.4 sustained | `pnpm -F @sessiondeck/hub load --rate 1000 --duration 60 --batch 100 --p95-limit 20` | 70900 envelopes accepted, 0 errors, 0 duplicates; p50 8.99, p95 12.28, p99 15.38, max 26.18 ms; achieved 1001/s over 65.8 s; pragmas synchronous=1 (NORMAL), wal; hub log 0 warn/error; "PASS (p95 12.28 ms)" | pass |
| R0.5 CI | `gh run view 39524443261 --json jobs` (push), `gh run view 39524449217 --json jobs` (pull_request); both headSha c187737, all jobs success | see below | pass |

uptime: before the load run `01:04:36 up 2 days, 20:36, load average: 4.63, 1.72, 1.14` (load elevated by the preceding typecheck and lint); after `01:05:50 up 2 days, 20:37, load average: 1.55, 1.42, 1.08`.

R0.5 step "test (R0.5 budget 60 s)" durations (budget 60 s):

| Job | push 39524443261 | pull_request 39524449217 |
|---|---|---|
| ubuntu node 22 | 25 s | 26 s |
| ubuntu node 24 | 21 s | 24 s |
| windows node 22 | 52 s | 46 s |
| windows node 24 | 38 s | 47 s |

Windows range 38 to 52 s against 33 to 45 s on the sprint base 78b3ba8 (run 39459664795). Note: the Windows R0.5 margin is thin (worst case 52 s of 60 s, 8 s headroom) and about 5 to 7 s slower than the base.

Verdicts: R2.4 pass, R2.9 (suite) pass, R2.10 (suite) pass, R0.5 (CI) pass.

## Re-confirmation on sprint/1-mvp merge (FIX-1, 2026-10-21)

Tree: sprint/1-mvp at 0e321fe plus staged uncommitted merge of p1/probe-hook. Linux WSL2 container, node v22.23.3, Docker available. One test process at a time, `--maxWorkers=2`. Hub suite is now 21 files, 282 passed (earlier rows recorded other counts for different commits).

| ID | Command | Result | Evidence |
|---|---|---|---|
| R2.1, R2.2, R2.3, R2.6, R2.7, R2.8 (unit) , R2.9 and R2.10 suites | `pnpm -F @sessiondeck/hub test -- --maxWorkers=2` | pass (21 files, 282 passed, 0 failed) | /state/1/gate/FIX-1/verify-hub-test.txt |
| R2.5 | `node packages/hub/scripts/ws-harness.mjs` | pass: fan-out 200 deltas p50 1.30 p95 3.16 max 32.01 ms (gate 100), dup 0, missing 0; reconnect dup 0 missing 0 | /state/1/gate/FIX-1/verify-ws-harness.txt |
| R2.8 container, R2.5 container | `node packages/hub/scripts/container-smoke.mjs` | pass ("SMOKE PASS"; auth, persistence, uid 10001, mode 0600, healthcheck; ws-harness vs container p95 2.53 max 40.92 ms, dup 0 missing 0; arm64 skipped, no buildx/qemu) | /state/1/gate/FIX-1/verify-container-smoke.txt |
| R2.4 | `pnpm -F @sessiondeck/hub load --rate 1000 --duration 60 --batch 100 --p95-limit 20` | pass: p95 12.22 ms (< 20), p99 15.16, max 25.83, 1001 env/s, 70900 events, hub log 0 warn/error. Container, not the Windows laptop | /state/1/gate/FIX-1/verify-load.txt |
| R2.9 | `cd packages/hub && node scripts/bench-replay.mjs` | pass: 1,020,000 events, replay 10683 ms (< 60000), reducer exceptions 0 | /state/1/gate/FIX-1/verify-replay.txt |
| R2.10 | `node packages/hub/scripts/ccusage-compare.mjs packages/hub/test/fixtures/transcripts --tz UTC,Asia/Tokyo` | pass: every row ok, 0.000000% delta, token deltas 0 (fixtures only; real-transcript comparison not re-run, snapshot deleted) | /state/1/gate/FIX-1/verify-ccusage.txt |
| Gates | typecheck, lint, test (root) | pass (exit 0) | /state/1/gate/FIX-1/{typecheck,lint,test}.txt |
| R0.5 | CI step "test (R0.5 budget 60 s)" | verified by CI (rows above); not re-run on the merged tree, local wall 5.25 s for scripts, hub 4.0 s | n/a |

Count: all re-run rows pass; verified by CI: R0.5 Windows budget; needs laptop: R2.4 and R2.9 laptop-native numbers.

## Re-confirmation on sprint/1-mvp merge of p1/probe-daemon (FIX-2, 2026-10-21)

Tree: sprint/1-mvp at 3d6167c plus staged uncommitted merge of p1/probe-daemon. Same commands as FIX-1; evidence under /state/1/gate/FIX-2/.

| ID | Command | Result | Evidence |
|---|---|---|---|
| R2.1, R2.2, R2.3, R2.6, R2.7, R2.8 (unit), R2.9 and R2.10 suites | hub tests via `pnpm -r test` (reused) | pass (21 files, 282 passed) | /state/1/gate/FIX-2/test.txt |
| R2.5 | `node packages/hub/scripts/ws-harness.mjs` | pass: fan-out 200 deltas p50 3.23 p95 9.42 max 94.89 ms (gate 100), dup 0, missing 0; reconnect dup 0 missing 0. Max is close to the gate; in-process timing varies run to run (FIX-1 max 32.01) | verify-ws-harness.txt |
| R2.8 container, R2.5 container | `node packages/hub/scripts/container-smoke.mjs` | pass ("SMOKE PASS"; ws-harness vs container p95 2.69 max 23.65 ms, dup 0 missing 0; arm64 skipped, no buildx/qemu). Script uses its own prefix sd-1-S3-; container and volume removed by the script | verify-container-smoke.txt |
| R2.4 | `pnpm -F @sessiondeck/hub load --rate 1000 --duration 60 --batch 100 --p95-limit 20` | pass: p95 12.99 ms (< 20), 70900 accepted, 0 duplicates, hub log 0 warn/error. Container, not the laptop | verify-load.txt |
| R2.9 | `cd packages/hub && node scripts/bench-replay.mjs --dir /tmp/sd-1-FIX-2-bench` | pass: replay 17948 ms (< 60000), reducer exceptions 0. The default dir /tmp/sd-1-S4-bench held a stale 1.7 GB db from FIX-1, so the default run failed at generate ("generated events were deduplicated"); that attempt is kept as verify-replay-stale-dir-attempt.txt. The script does not clear its dir; the fresh dir /tmp/sd-1-FIX-2-bench was left in place because the guard blocks rm -rf outside the repo | verify-replay.txt |
| R2.10 | `node packages/hub/scripts/ccusage-compare.mjs packages/hub/test/fixtures/transcripts --tz UTC,Asia/Tokyo` | pass: all rows ok, 0.000000% delta (fixtures only) | verify-ccusage.txt |

Count: all R2.x rows re-run pass; verified by CI: R0.5 Windows budget; needs laptop: R2.4 and R2.9 laptop-native numbers.


# FIX-3 re-confirmation (merge p3/board-mock)

Verified 2026-10-21T01:59:45Z by sd-verifier. Staged merge of p3/board-mock (S5) into sprint/1-mvp, base 88d9c07. Command: `git diff --cached --quiet 88d9c07 -- packages/hub packages/probe packages/contract`, exit 0 (empty diff: hub, probe and contract are byte-identical to 88d9c07). Full suite on the merged tree: /state/1/gate/FIX-3/test.txt, Test Files 28 passed | 1 skipped, Tests 575 passed | 7 skipped, exit 0. Benches not rerun (diff empty). All existing R2.x rows still PASS: no source they cover changed. Result: PASS (no regression). Evidence for the diff check is the exit code only; it was not saved to a file.
