# Verification, Phase 2 (hub), S3 scope

- Branch: p2/hub-core, HEAD 416b3ca. All rows re-run at this commit (hub src unchanged since 7425f9e; U7 changed only hub test helpers, migrations.test.ts and vitest.config.ts); earlier per-commit evidence is superseded (see git history of this file).
- Run: 2026-10-20T16:16Z to 16:30Z (UTC). Machine: Linux 6.18.33.2-microsoft-standard-WSL2 (sprint container), AMD Ryzen AI 9 465 w/ Radeon 880M, node v22.23.3, Docker available.
- Scope: R2.1, R2.2, R2.3, R2.5, R2.6, R2.7, R2.8, plus R0.5 CI evidence. R2.4 and R2.10 (compose) are S4 and not verified here.

## Repo-wide gates (from repo root)

| Command | Evidence | Verdict |
|---|---|---|
| `pnpm -r test` | exit 0, 10 s wall (hub 7.5 s). contract: 28 files, 1090 passed, 1 skipped. scripts: 28 files passed, 1 skipped, 575 passed, 7 skipped. hub: 15 files, 177 passed, 0 failed. | pass |
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
| R0.5 `pnpm -r test` inside 60 s budget on the CI matrix | `gh run view 39443991770` (pull_request) and `39443984373` (push), both HEAD 416b3ca | all four jobs success in both runs (ubuntu-latest node 22 and 24, windows-latest node 22 and 24). Step "test (R0.5 budget 60 s)" on Windows: PR run node 22 40 s (14:59:34Z to 15:00:14Z), node 24 38 s; push run node 24 36 s, node 22 41 s. Ubuntu 13 to 25 s. Local Linux run 10 s. Worst Windows headroom 19 s (32 %); see note 2. | pass |
| R2.4 | not in S3 scope | | S4 |
| R2.10 (compose) | not in S3 scope | | S4 |

## Notes

1. Test count moved from 204 (at fab329c) to 177 (unchanged at 416b3ca). The change is in commits f6b9603 and b6d6133, which trimmed redundant cells of the R2.3 golden batch-size x mode matrix (52 to 25 tests) to fit the R0.5 budget on Windows, and added a full-golden comparison to the golden-session timeline test. Coverage is narrowed but each golden file is still compared in three modes; the reviewer may judge whether that is enough.
2. After U7 (in-memory test stores, isolate:false, maxWorkers 2) the Windows R0.5 step is 36 to 41 s, down from 49 to 52 s at 7425f9e; headroom is now 19 s or more.
3. The ws-harness runs the hub in-process; the container run covers the real network path. Harness maximum latency is noisy and has reached 82.54 ms against the 100 ms gate in one earlier run.
4. Not re-run in this pass: the no-outbound-network grep of packages/hub/src and the live curl checks recorded in earlier versions of this file; the hub src is unchanged since fab329c except tests and vitest config (`git diff fab329c HEAD -- packages/hub` touches only test files and vitest.config.ts).
