# VERIFY-P0: Phase 0 contract, requirements R0.1 to R0.8

- Branch: `p0/scaffold`, HEAD `16ff3478dbe3ff5f85adaf4a1153acd5bac2cb10` (16ff347), clean tree apart from this file (S0 pass). Rows marked S0b were re-run on `p0/fixtures` at 21da7db, 2026-10-16, 05:00Z to 05:10Z (see the S0b section at the end)
- Date (UTC): 2026-10-09, runs 05:48Z to 05:52Z (S0 rows); 2026-10-16 (S0b rows)
- Machine: Windows 11 Home 10.0.26200 (Git Bash, MINGW64), Node v24.19.0, pnpm 12.10.1; CI runs Node 22 and 24 on ubuntu-latest and windows-latest
- Verifier: sd-verifier. Every row below comes from a command run at 16ff347 in this pass.

## Scope of this pass

S0 builds the contract, reducer, capture tooling and scaffold. The user's capture day and the fixture session S0b come after S0 by plan (`docs/planning/04-session-map.md` section 2, `docs/handoffs/S00b-fixtures-and-reducer-finalization.md`). Clauses that needed captured real-session fixtures (R0.1 fixture walk, R0.2 golden timeline, R0.4 captured statusLine parse, R0.7 fixture count and scrub review) were first marked pending and existed as placeholder tests until fixtures existed. S0b supplied the fixtures and every one of those rows now carries a result from a run at 21da7db (or the commit named in the row); none is pending. R0.8 belongs to S0c. All other clauses are proven now, on synthetic payloads where stated. Result values: `pass`, `fail`, `out of scope (S0c)`. S0c (sprint tooling) added the result `needs laptop confirmation (live tokens)`, resolved by the laptop run of 2026-10-15 recorded in the S0b section; S0c has its own section above the S0b section.

## Results

| Requirement | Clause | Command | Key output | Result | Timestamp |
|---|---|---|---|---|---|
| R0.1 | rejects missing v, id, host, kind, ts, seq | `pnpm -r test` at 21da7db (`packages/contract/test/envelope.test.ts:21` `it.each([v,id,host,kind,ts,seq])("rejects a missing %s")`); also `pnpm exec vitest run test/envelope-walk.test.ts test/envelope.test.ts --coverage.enabled=false` in packages/contract | envelope.test.ts 22 passed (incl. 6 missing-field rejections), envelope-walk 512 passed, 0 failed, 0 skipped; contract 27 files, 1048 passed / 0 skipped / 0 failed. The S0 first pass (16ff347) had 23 tests with 1 skipped; the skip is gone | pass | S0 05:49Z; re-confirmed at 21da7db 2026-10-16 05:05Z |
| R0.1 | validates every captured fixture when wrapped | `pnpm exec vitest run test/envelope-walk.test.ts test/envelope.test.ts test/statusline.test.ts --coverage.enabled=false` in packages/contract at 21da7db (`envelope-walk.test.ts`) | 3 files, 578 passed, 0 failed, 0 skipped (512 + 22 + 44; identical to the 9839118 run). Walked: hooks 176 files over 13 events, statusLine 20, subagentStatusLine 5, golden session 295 lines, synthetic 5 (reported separately, not captured; see the synthetic note in the S0b section). Each category has a not-empty guard and a wrapped-fixture test that removing v, id, host, kind, ts or seq is rejected | pass | 2026-10-16 05:05Z (was 9839118, 04:17Z) |
| R0.2 | reduce() is pure and total | `pnpm exec vitest run test/state.test.ts test/state-fixtures.test.ts test/state-golden.test.ts --coverage.enabled=false` at 21da7db (`packages/contract/test/state.test.ts:191` describe "R0.2 purity and totality", `:209` every state x event x payload gives a valid, fresh snapshot with last_event_at = e.ts, `:229`, `:234`, `:242`); frozen inputs: `packages/contract/test/state-golden.test.ts:218` describe "golden session: purity", `:219` same input twice gives deep-equal output, `:224` "deep-frozen inputs are neither mutated nor rejected, and the result is unchanged" (`replayAll(freeze)` at `:62` deep-freezes the state and every envelope, `:64-70`) | state.test.ts 61, state-golden.test.ts 13, state-fixtures.test.ts 32: 106 passed, 0 failed, 0 skipped; the frozen replay of all 295 events neither throws nor changes the result | pass | 2026-10-16 05:06Z |
| R0.2 | real-session fixture sequence produces the expected timeline (golden) | same command; `packages/contract/test/state-golden.test.ts:78` describe, `:79` "has the 295 events the timeline file was written for", `:83` "produces exactly the hand-verified state changes", `:107` every change names the transition row that fires it, `:118` "ends in the hand-verified final snapshot", `:138` bookkeeping invariants after every event, `:155` events 217 and 229 change nothing but last_event_at, `:165` and `:174` no subagent event leaves idle or waiting_input; fixtures `packages/contract/fixtures/sessions/golden-session.jsonl`, `golden-session.timeline.json`, `golden-session.timeline.md` | 295 events, 11 state changes, final state ended with detail clear; all 13 golden tests pass. Hand-verified 11/11 against transitions.ts by sd-reviewer twice (iteration 1 at 22a648d and iteration 2 at dc35b08; session log `docs/sessions/p0-fixtures.md` U3, lines 86 and 92). The verifier did not repeat the hand verification and cites it. The earlier skipped placeholder (`expect.fail` TODO) no longer exists | pass | 2026-10-16 05:06Z |
| R0.3 clause 1 | PermissionRequest gives waiting_permission | same command (`packages/contract/test/state.test.ts:23` synthetic; captured sequence `packages/contract/test/state-fixtures.test.ts:53` "for every captured PermissionRequest", 4 captured fixtures) | pass, 0 skipped | pass | 2026-10-16 05:06Z |
| R0.3 clause 2 | Notification permission_prompt while already waiting is a no-op | same command (`state.test.ts:29` synthetic, related `:41`, `:49`, `:58`; captured `state-fixtures.test.ts:65`) | pass | pass | 2026-10-16 05:06Z |
| R0.3 clause 3 | Stop after AskUserQuestion gives waiting_input | same command (`state.test.ts:66` synthetic, `:74` ExitPlanMode, `:81` Bash gives idle; captured `state-fixtures.test.ts:72` and `:78` "the whole captured ask sequence ends in waiting_input") | pass | pass | 2026-10-16 05:06Z |
| R0.3 clause 4 | StopFailure gives error | same command (`state.test.ts:102` "StopFailure gives error and records the error type"; `state-fixtures.test.ts:283` describe "StopFailure (synthetic payload, not captured)", `:286`, `:294`). No captured sequence: no StopFailure occurred in the capture (conductor decision 7; synthetic note of 2026-10-16 in the S0b section) | pass on a synthetic payload | pass (synthetic payload) | 2026-10-16 05:06Z |
| R0.3 clause 5 | SessionEnd gives ended with reason | same command (`state.test.ts:109` synthetic, `:115` without a string reason gives 'unknown'; captured `state-fixtures.test.ts:91` "for every captured SessionEnd", 3 captured fixtures) | pass | pass | 2026-10-16 05:06Z |
| R0.3 clause 6 | liveness dead gives exited | same command (`state.test.ts:119` "liveness alive:false gives exited; no change when already ended", `:129`, `:134`, `:140`). Synthetic only: liveness events come from the probe, not from Claude Code, so there is no captured sequence | pass | pass (synthetic payload) | 2026-10-16 05:06Z |
| R0.3 clause 7 | same-pid new session_id marks previous ended | same command (`state.test.ts:149` describe supersedeSamePid, `:153` "ends the previous session on the same host and pid as superseded", `:164`, `:178`, `:183`). Synthetic only: no captured sequence holds two sessions on one pid | pass | pass (synthetic payload) | 2026-10-16 05:06Z |
| R0.4 | parses a sample with rate_limits (synthetic) | same (`packages/contract/test/statusline.test.ts:28`) | pass; payloads are synthetic (session_id "synthetic-session") | pass | 05:49Z |
| R0.4 | parses a sample without rate_limits (synthetic) | same (`statusline.test.ts:41`) | pass | pass | 05:49Z |
| R0.4 | parses current_usage null (synthetic) | same (`statusline.test.ts:46`) | pass | pass | 05:49Z |
| R0.4 | #52326 leak: percentage carrying the resets_at epoch becomes null (synthetic) | same (`statusline.test.ts:131` "nulls the #52326 leak"; `:143` out-of-range and non-finite) | pass | pass | 05:49Z |
| R0.4 | parses captured statusLine fixtures; with and without rate_limits, current_usage null, #52326 leak | `pnpm exec vitest run test/statusline.test.ts --coverage.enabled=false` in packages/contract at 21da7db (`statusline.test.ts`); also inside `pnpm -r test` | 44 passed, 0 failed, 0 skipped (same as at 9839118). All 20 statusLine (17 with `rate_limits`) and 5 subagentStatusLine samples parse; captured five_hour and seven_day windows normalize; the captured current_usage-null sample parses. The leak case is DERIVED from a captured sample (the capture has no leak, its max is 96): percentage above 100 becomes null | pass | 2026-10-16 05:05Z (was 9839118, 04:17Z) |
| R0.5 | CI green on both OSes | `gh run list --branch p0/scaffold --limit 3`; `gh run view 37890035505 --json conclusion,headSha,jobs` | run 37890035505 is for headSha 16ff347, conclusion success; all four jobs success: ubuntu-latest node 22, ubuntu-latest node 24, windows-latest node 22, windows-latest node 24 | pass | 05:49Z |
| R0.5 | `pnpm -r test` under 60 s | `time pnpm -r test` (twice) | wall 8.9 s and 8.9 s (contract 12 files, scripts 17 files); CI test step "test (R0.5 budget 60 s)": ubuntu/22 10 s, ubuntu/24 12 s, windows/24 31 s, windows/22 35 s | pass | 05:49Z |
| R0.6 | `docs/planning/` matches the vault copy | `diff -rq --strip-trailing-cr C:/Users/stack/vault/projects/sessiondeck/planning docs/planning` | no output, exit 0 (content equal; checkout is CRLF) | pass | 05:49Z |
| R0.6 | `.claude/agents/` contains the nine sd-* agents | `ls .claude/agents/sd-*.md` | 12 files: all nine named agents present (orchestrator, executor-contract/probe/hub/web/infra, reviewer, security-reviewer, verifier) plus conductor, researcher, sprint-orchestrator | pass | 05:49Z |
| R0.6 | scaffold test | `pnpm -F @sessiondeck/scripts test` (`scripts/test/scaffold.test.ts`, "R0.6 project scaffold files") | scaffold.test.ts 23 tests pass | pass | 05:49Z |
| R0.7 | capture tooling exists and works: 17 hook events plus statusLine registered in exec form, existing hooks preserved, hook silent and exit 0, payload written under raw/<event>/, uninstall restores | harness (step 9, transcript below) plus `pnpm -F @sessiondeck/scripts test` | install exit 0; 17 events registered; Stop group shows `"command":"node"` with `args`, the fixture's own `stop-notify.sh` group preserved; hook exit 0, 0 stdout bytes, 0 stderr bytes; file under `raw/Stop/`; uninstall exit 0; `restored equals original: true`; scripts suite 17 files, 227 passed / 3 skipped / 0 failed | pass | 05:50Z |
| R0.7 | raw captures cannot be committed by accident | `git ls-files packages/contract/fixtures`; `git check-ignore -v packages/contract/fixtures/raw/x` | tracked: only `fixtures/settings/README.md` and `with-harness-hooks.json`; ignored by `.gitignore:45:packages/contract/fixtures/raw/` | pass | 05:49Z |
| R0.7 | at least 50 raw fixtures across at least 12 hook events plus 20 statusLine samples committed, scrubbed, reviewed by sd-security-reviewer | at 21da7db: `git ls-files packages/contract/fixtures` (counts per dir); `git ls-files packages/contract/fixtures \| grep -c /raw/`; `git check-ignore -v packages/contract/fixtures/raw/x`; `pnpm -r test` (`fixtures-counts.test.ts` also run alone); `pnpm -F @sessiondeck/scripts run fixture:leak`; `docs/sessions/p0-fixtures.md` U1 | 176 captured hook fixtures across 13 events (PreToolUse 62, PostToolUse 84, PostToolUseFailure 6, PermissionRequest 4, Notification 3, SessionStart 3, SessionEnd 3, Stop 3, SubagentStop 3, UserPromptSubmit 2, PreCompact 1, PostCompact 1, SubagentStart 1); 20 statusLine samples; 5 subagentStatusLine; 3 golden session files under `fixtures/sessions`; tracked paths under `raw/`: 0 (`.gitignore:45:packages/contract/fixtures/raw/` ignores it; the local `raw/` directory holds 17 entries, count only, not read); 5 synthetic files (TaskCreated, TaskCompleted, PermissionDenied, StopFailure; not counted toward captured totals; synthetic note of 2026-10-16 in the S0b section); `fixtures-counts.test.ts` 7 passed; contract 27 files, 1048 passed / 0 skipped; leak gate `files scanned: 213`, `PASS: no leaks found` (210 at bdcbaca; the 3 extra files are consistent with the golden timeline and CONTRACT.md scans added in U2 and U3); sd-security-reviewer "Gate: pass" at 3899726 (before the fixture commit), a6984c2, 2c61aa2, then the U2 and U3 gates (see Definition of done) | pass | 2026-10-16 05:07Z (was bdcbaca, 03:37Z) |
| R0.8 | `run-sprint.ps1 -Sprint smoke` produces `.sprint/smoke/status.json` with state green within two minutes on Docker Desktop for Windows | live smoke run with real tokens on the laptop, reported by the conductor (2026-10-15); evidence file `C:/Users/stack/projects/sessiondeck/.sprint/0/gate/smoke-evidence-run2.txt` read by the verifier (quoted in full in the S0b section; nothing token-shaped in it). Earlier: harness `bash infra/sprint/test/check-sprint-image.sh` with the stub `claude` (S0c section, E2) and the placeholder run (E5) | `RESULT: PASS`, `final_state: green`, `wait_seconds: 16.2` counted after run-sprint returned (start_seconds 2.8, so about 19 s from invoking run-sprint; limit 120 s), `container: running`, run-sprint exit 0, stop-sprint exit 0. The verifier did not run this (no tokens on this machine); the result is the conductor's laptop run plus the evidence file | pass (laptop run 2026-10-15, evidence file) | 2026-10-15 (run), recorded 2026-10-16 05:08Z |
| R0.8 | the renderer has a test per package block in `MINI-SPRINT-ORDER.md` | `pnpm -F @sessiondeck/scripts test:sprint` (renderer files: `pnpm exec vitest run -c vitest.sprint.config.ts test/sprint-render` in `scripts/`); `scripts/test/sprint-render.test.ts:26` ("one test per package block"), `:27` finds exactly sprints 0 to 5, `:31` one yaml fence per tested block, `:37` `it.each(packages)` | 7 files, 126 passed / 0 failed (verified by CI in the sprint tooling step); CLI re-run at 33bde60 exits 0 for 0, 1 to 5 (`--contract-sha 0123abc`) and smoke; renders sprint 0 (54 lines), 1 (61), 2 (54), 3 (55), 4 (58), 5 (56) and smoke (1) with exit 0; `--sprint 9` exits 2 with the valid ids. No `{NAME}` placeholder left except the two documented pass-throughs `{SESSION_ID}` and `{SESSION_BRANCH}` and the literal `${CLAUDE_PROJECT_DIR}` text inside package 0 | pass | 23:15Z |
| R0.8 | tokens enter only through `.sprint/env` | static tests + harness check 6 + repo grep (S0c section, E6) | `git check-ignore -v .sprint/env` hits `.gitignore:18 .sprint/`; compose has `env_file: ${SPRINT_ENV_FILE:-../../.sprint/env}` and no interpolated token; Dockerfile has no token ARG/ENV (`sprint-image-static.test.ts:490`); `run-sprint.ps1` only `Test-Path`s the file (line 131) and has no `Get-Content`/hash/copy anywhere in `scripts/sprint`; harness check 6: 0 matches in docker logs, state logs, `sprint.jsonl`, `~/.gitconfig`, `/work/.git/config`, `docker history --no-trunc`; no token-shaped value in tracked files | pass | 22:07Z |
| R0.8 handoff | `infra/sprint/Dockerfile` | `infra/sprint/test/check-sprint-image.sh` build + checks 5, 9; `sprint-image-static.test.ts` (63 tests) | image `sessiondeck-sprint:local` id bfb55e2edf3e built from it; non-root uid 1000 (harness 2); root refused with the documented message, non-root exits 1 with an auth error (check 5); shellcheck clean (check 9); no token in `docker history` | pass | 21:38Z |
| R0.8 handoff | `infra/sprint/docker-compose.yml` | harness check 1 (compose v5.6.0 present) and 3 (socket reaches host daemon: server 29.8.1; sibling container ran and was removed); `sprint-image-static.test.ts:554,558,575` | env_file only, no interpolated token, code-loading names pinned empty; run of the compose service reaches the pre-stage and the entrypoint | pass | 21:38Z |
| R0.8 handoff | `infra/sprint/entrypoint.sh` (and `entrypoint-precheck.sh`) | harness checks 4, 6, 7, 8, 10; `sprint-image-static.test.ts` entrypoint and pre-stage blocks | 34 guard checks (check 7) refuse unlisted or hostile variables with exit 64 naming the variable; BASH_ENV marker never ran; clone path once, fetch path on second run (8); SIGTERM forwarded, exit 143 within 1 s of 15 s (10); entrypoint never echoes a token value (`:114`) | pass | 21:38Z |
| R0.8 handoff | `scripts/sprint/run-sprint.ps1` with `-Sprint` and `-Resume` | `pnpm -F @sessiondeck/scripts test:sprint` (`sprint-ps-run.test.ts`, 32 tests, 32 passed at 33bde60; `-Resume` appears on 11 lines of the test file); `run-sprint.ps1:51` param, `:230-232` resume needs an existing state dir | 279 passed / 0 failed in the sprint tooling suite (13 files, 44 s locally; verified by CI: sprint step green on both windows jobs in both runs, 76 to 112 s); remote docker target refused exit 3, planted links refused exit 4 | pass | 23:15Z |
| R0.8 handoff | `scripts/sprint/status.ps1` | same command, now `test:sprint` (`sprint-ps-stop-status.test.ts`, 27 tests with stop) | pass in the 279 (verified by CI); output reduced to printable ASCII, link rows shown as `link refused` | pass | 23:15Z |
| R0.8 handoff | `scripts/sprint/stop-sprint.ps1` | same command; placeholder smoke run (E5) and harness check 10 | `stop-sprint: ran, exit 0` after the smoke run; "stopped sprint-smoke; kept volume sprint-smoke-work and the state directory"; `docker ps -a --filter name=sd-0-S0c --filter name=sprint-smoke` empty afterwards | pass | 22:08Z |
| R0.8 handoff | `scripts/sprint/render-prompt.mjs` with unit tests against every package block | see the second R0.8 row; 7 renderer test files | 126 passed (verified by CI) / 0 failed; 6 package blocks plus smoke render | pass | 23:15Z |
| R0.8 handoff | `.sprint/` state layout and the atomic-write helper `packages/contract/src/state-file.ts` | `pnpm -r test` (contract), re-run at 33bde60: 9 `state-file-*.test.ts` files (index, secrets, layout, status, lock, atomic, merge, cli-merge, cli) | contract 22 files, 434 passed / 13 skipped (433 on ubuntu CI) (the 13 were the S0 pending-fixture skips; at 21da7db the contract suite has 0 skips) / 0 failed; `state-file.ts` 100 % lines and branches; `state-file-cli.ts` 96.33 % lines (uncovered 158-161); no per-file threshold failed (run exit 0; verified by CI on both OSes) | pass | 23:12Z |
| R0.8 handoff | smoke package (`-Sprint smoke`) | `node scripts/sprint/render-prompt.mjs --sprint smoke`; harness; `smoke-check.ps1`; live run 2026-10-15 | renders exactly one line (`write /state/smoke/status.json with state green and exit`), runs through the container end to end with the stub (green), with placeholders (to the clone), and with real tokens (green after 16.2 s, evidence file in the S0b section) | pass | 2026-10-15 (live run), recorded 2026-10-16 05:08Z |
| R0.8 handoff | `infra/sprint/README.md` turned into documentation: `claude setup-token` procedure, token lifetime, GitHub fine-grained token scopes | read `infra/sprint/README.md`: setup step 1 (`:88`), step 2 (`:89-95`), security note (`:30-84`), smoke test (`:116-131`) | `claude setup-token` steps, one-year lifetime and "revoking is not documented" at `:88`; fine-grained scopes (Contents RW, Pull requests RW, Actions R, Commit statuses R, Metadata R, 366-day maximum) at `:90-95`; the README itself says the GitHub details came through a summarizer and must be checked on the token page, and that revoking either token is unverified. Research is recorded in `docs/sessions/p0-sprint-tooling.md:22,73` (no separate note under `docs/research/`) | pass | 22:06Z (README diff since b4b8177 touches only the Testing section) |

### Static gates (supporting, same commit)

| Command | Key output | Wall | Exit |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | "Lockfile is up to date, resolution step is skipped"; "Done in 95ms" | 0.6 s | 0 |
| `pnpm -r typecheck` | `scripts typecheck: Done`, `packages/contract typecheck: Done` | n/a | 0 |
| `pnpm -r lint` | both packages Done | n/a | 0 |
| `pnpm lint:root` | `eslint .` no findings | n/a | 0 |
| `pnpm format:check` | "All matched files use Prettier code style!" | n/a | 0 |

Test counts (`pnpm -r test`, identical on both runs; skipped = the pending and platform-skip tests listed in this file):

| Package | Files | Passed | Skipped | Failed |
|---|---|---|---|---|
| `@sessiondeck/contract` | 12 | 238 | 13 | 0 |
| `@sessiondeck/scripts` | 17 | 227 | 3 | 0 |

Contract skips: 13, all `TODO(fixture)` or provisional placeholders (`envelope.test.ts:108`, `statusline.test.ts:182`, `state-permission.test.ts:101`, `state-review2.test.ts:78`, `state.test.ts:419,425,431,437,443,449,524`, plus the two `describe.skipIf(...length === 0)` blocks that hold the captured-fixture walks). Scripts skips: 3, platform or environment skips (symlink privilege, POSIX-only block on Windows). Superseded at 21da7db (S0b section): contract 27 files, 1048 passed, 0 skipped; scripts 25 files, 418 passed, 3 skipped.

## Definition of done

| Item | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| 100% line coverage on `packages/contract/src/state.ts` and `envelope.ts` | `pnpm -r test` at 21da7db (contract script `vitest run --coverage`, v8) | `envelope.ts \| 100 \| 100 \| 100 \| 100`; `state.ts \| 100 \| 100 \| 100 \| 100`; `transitions.ts \| 100 \| 100 \| 100 \| 100` (columns: statements, branches, functions, lines); all-files lines 98.83 (some other files, for example state-file-sweep.ts at 87.09, are lower; they carry no 100 % requirement). Per-file `lines: 100` thresholds in `packages/contract/vitest.config.ts` apply to envelope.ts, state.ts and the files the reducer is built from; the run exits 0, so the thresholds held. `transcript.ts` shows 0 across the row (no executable lines) and has no threshold. The S0 pass at 16ff347 (05:49Z) was also pass | pass | 2026-10-16 05:00Z |
| `docs/CONTRACT.md` exists and its diagram is generated from the transition table | `pnpm -F @sessiondeck/contract gen:doc -- --check` at 21da7db; drift test `packages/contract/test/docs.test.ts` (inside the 1048) | `docs/CONTRACT.md is up to date.`, exit 0; docs.test.ts passes. S0 pass at 16ff347 also pass | pass | 2026-10-16 05:03Z |
| sd-reviewer has signed off | `docs/sessions/p0-fixtures.md`: U3 iteration 2 at dc35b08 "merge, no findings" (line 92), U2 iteration 1 at 26961d8 "merge" (line 79), U4b "merge" (lines 69 to 71), U1 round 3 "fix-then-merge" with the MAJOR resolved by record (lines 52 and 53) | recorded by the orchestrator in the session log; the verifier cites it and did not repeat the reviews. The session log's close task (this verification, then the PR) is still open | pass (as recorded) | 2026-10-16 05:09Z |
| sd-security-reviewer has signed off the fixtures | `docs/sessions/p0-fixtures.md`: U1 round 1 "Gate: pass" at 3899726 (before the fixture commit; 4 MEDIUM, 3 LOW on the controls, data clean, line 49), round 2 at a6984c2 "Gate: pass", round 3 at 2c61aa2 "Gate: pass" (0 CRITICAL, 0 HIGH, 3 LOW, line 52); U2 at 26961d8 "Gate: pass" (2 LOW, line 79); U3 iteration 1 at 22a648d "Gate: pass" (1 MEDIUM, 2 LOW, line 86, fixed in dfba834 and dc35b08) and iteration 2 at dc35b08 "Gate: pass" (2 LOW deferred, line 92); U4b gates at f781950, c1f4a9b, 9d5d39b and the re-check after 8c97dc6 "Gate: pass" (lines 69 to 71). Leak gate at 21da7db: 213 files, PASS | pass (as recorded; the verifier cites the reports and re-ran only the leak gate) | 2026-10-16 05:09Z |
| U4b `.claude/` changes are applied | `docs/patches/S0b-claude-dir.patch` exists (with `docs/patches/README.md`); session log line 73: the repo worktree's `.claude/` was never written | Claude Code refused edits under `.claude/` in this non-interactive session, so the guard.mjs rule, the Read deny rule and the fixture-capture SKILL.md change ship as a patch; reviewed (merge and security gate pass, lines 69 to 71), NOT YET APPLIED. A user step; not counted in the totals | not applied (user step) | 2026-10-16 05:09Z |
| `sd-security-reviewer` has signed off the sprint tooling (tokens, docker socket) (added by S0c) | recorded evidence, not re-run: `docs/sessions/p0-sprint-tooling.md` decisions 21 and 22; verbatim reports in `C:/Users/stack/projects/sessiondeck/.sprint/0/tmp-S0c/R6-final-reviews.md` section A (a18255d) and section F (b4b8177) | "Gate: pass for the whole branch" at a18255d and again at b4b8177; no CRITICAL or HIGH; one LOW deferred (`packages/contract/src/state-file-secrets.ts:40`: token-start rule misses a token right after a literal backslash-letter pair). `sd-reviewer` "Verdict: merge" at b4b8177 (section E). Tokens clause: R0.8 token row above. Socket clause: README states the socket mount is root-equivalent (`infra/sprint/README.md:34`, section "The docker socket and the container" `:32-50`) and lists alternatives with cost (`:42-50`). User acceptance of the socket (or choice of an alternative) is a user step and is still open; it is not counted as a fail | pass (as recorded; verifier cites the reports, it did not re-run the reviews) | 22:10Z |

## CI detail (run 37890035505, headSha 16ff347, conclusion success)

| Job | Conclusion | Test step ("test (R0.5 budget 60 s)") |
|---|---|---|
| check (ubuntu-latest, node 22) | success | 10 s (05:45:08Z to 05:45:18Z) |
| check (ubuntu-latest, node 24) | success | 12 s (05:45:11Z to 05:45:23Z) |
| check (windows-latest, node 22) | success | 35 s (05:46:00Z to 05:46:35Z) |
| check (windows-latest, node 24) | success | 31 s (05:45:47Z to 05:46:18Z) |

`gh run list` (newest first): 37890035505 success at 16ff347 ("fix(scripts): report error, not full, when the out dir cannot be listed"), 37889336521 failure (earlier commit bb5d8b9, superseded), 37887574408 success (earlier commit).

## Capture-tooling harness transcript (R0.7 tooling share)

Ran only inside a temp sandbox: `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `XDG_DATA_HOME` and `SESSIONDECK_CAPTURE_HOME` all pointed under it, `CLAUDECODE` unset. `cygpath` present; the resolved `CLAUDE_CONFIG_DIR` was confirmed to be under the temp directory before the installer ran. Every "Target settings file:" line printed (dry run, apply, uninstall) was `<SANDBOX>\cfg\settings.json`. The sandbox settings file started as a copy of `packages/contract/fixtures/settings/with-harness-hooks.json`. The harness was run in two blocks (dry run first as the safety check, then the rest against the same sandbox) with the same environment.

```
CLAUDE_CONFIG_DIR=<SANDBOX>/cfg   (under the temp directory: ok)
Target settings file: <SANDBOX>\cfg\settings.json
... 17 "+ hooks.<Event>" lines, each {"type":"command","command":"node","args":[".../deploy/capture-fixtures.mjs","--marker","sessiondeck-capture","--out",".../raw"],"timeout":5}
    (SessionEnd entry has no timeout)
+ statusLine: {"type":"command","command":"node \".../deploy/capture-fixtures.mjs\" --marker sessiondeck-capture --statusline --out \".../raw\""}
+ subagentStatusLine: {... --subagents ...}
- statusLine: (not a capture entry) type=command length=42      (previous value recorded for restore)
Deployed copy: 8 file(s) to write in <SANDBOX>\deploy
Dry run: nothing was written. Re-run with --apply to write.
dry-run exit=0

Target settings file: <SANDBOX>\cfg\settings.json
apply exit=0
events: 17 PreToolUse,PostToolUse,Stop,SessionEnd,SessionStart,UserPromptSubmit,PostToolUseFailure,PermissionRequest,PermissionDenied,Notification,SubagentStart,SubagentStop,TaskCreated,TaskCompleted,StopFailure,PreCompact,PostCompact
Stop groups: [{"hooks":[{"type":"command","command":"bash <HOME>/.example-harness/hooks/stop-notify.sh"}]},{"hooks":[{"type":"command","command":"node","args":["<SANDBOX>/deploy/capture-fixtures.mjs","--marker","sessiondeck-capture","--out","<SANDBOX>/raw"],"timeout":5}]}]
statusLine: {"type":"command","command":"node \"<SANDBOX>/deploy/capture-fixtures.mjs\" --marker sessiondeck-capture --statusline --out \"<SANDBOX>/raw\""}
hook exit=0 stdout_bytes=0 stderr_bytes=0
<SANDBOX>/raw:   Stop  _usage.log
<SANDBOX>/raw/Stop:   1791524996328-verify-0-2b1daa71b1c1.json

Target settings file: <SANDBOX>\cfg\settings.json
uninstall exit=0
restored equals original: true
```

Cleanup: the 10 sandbox files were removed by name and the directories with `rmdir`; the sandbox temp directory no longer exists. An empty directory from the preflight `mktemp` (`/tmp/tmp.LgK5rat4YX` in Git Bash) was also removed.

Observations for the reader (not failures):
- The event count of 17 is the union with the fixture's own events: the fixture already had PreToolUse, PostToolUse, Stop and SessionEnd groups, and all four kept their original entries next to ours (shown for Stop).
- The statusLine and subagentStatusLine entries are shell command strings, not `command` plus `args`. The exec form applies to hook entries; Claude Code's statusLine setting takes a single command string.
- `.claude/agents/` holds 12 `sd-*` files, three more than the nine R0.6 names.

## Totals

Requirement table: 37 rows (24 from S0 plus 13 from S0c, which replaced the old R0.8 row). The four rows that were waiting for the fixture session (R0.1 fixture walk, R0.2 golden timeline, R0.4 captured statusLine, R0.7 fixture count and review) are all pass at 21da7db (R0.1 and R0.4 re-confirmed from 9839118, R0.7 from bdcbaca), and the R0.8 live row is pass on the laptop run of 2026-10-15. Requirement result: 37 pass / 0 fail / 0 pending / 0 needs laptop confirmation. Definition of done: 5 pass (coverage, CONTRACT.md, sd-reviewer as recorded, sd-security-reviewer fixtures as recorded, sprint-tooling security sign-off as recorded), plus 1 user step open and not counted (apply `docs/patches/S0b-claude-dir.patch`). The S0b section at the end has the commit, commands and outputs.

Overall: 42 pass / 0 fail / 0 pending (open, not counted: apply the U4b patch)

## S0c: sprint tooling (R0.8 and the sprint-tooling sign-off)

- Branch `p0/sprint-tooling`, HEAD 33bde60 (updated pass; earlier passes verified 842e199 and 61811a7). Since 61811a7: a6e9510 (batched spawns in the S0c tests; ENOTDIR treated as nothing to remove), a2ac93d and 0966704 (sprint tooling tests moved to `test:sprint` and their own CI step; drift guard `test-split.test.ts`; README testing section), 0d2ef5b and 33bde60 (root `ci` script runs `test:sprint`; PowerShell harness throws on CI when no PowerShell starts; shell batch timeout tested). Code under `scripts/sprint`, `infra/sprint` and `packages/contract/src` changed only in the `discardTemp` ENOTDIR handling. Base `sprint/0-bootstrap` at 3702f2c, no rebase needed. Date (UTC) 2026-10-14, local runs about 23:10Z to 23:20Z.
- Machine: Windows 11 Home 10.0.26200, AMD Ryzen AI 9 465, 31,898 MB RAM, Node v24.19.0, pnpm 12.10.1, Docker server 29.8.1, Compose v5.6.0. Commands run one at a time, no background processes.
- Verifier: sd-verifier. Result value added in this pass: `needs laptop confirmation (live tokens)` (the clause needs real `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`, which this machine does not hold by design; what was proven then is stated in the row; it was neither pass nor fail, and was resolved on 2026-10-15, see the S0b section).

### E1: full suites at 33bde60 (local, 2026-10-14, Windows, Node v24.19.0, commands run one at a time)

| Command | Key output | Wall | Exit |
|---|---|---|---|
| `pnpm -r test` | contract: 22 files, 434 passed / 13 skipped / 0 failed (vitest 6.90 s); scripts: 18 files, 232 passed / 3 skipped / 0 failed (vitest 10.5 s; two runs, 10.39 s and 10.52 s) | 11 s and 12 s (R0.5 step budget 60 s: within) | 0 |
| `pnpm -F @sessiondeck/scripts test:sprint` | 13 files, 279 passed / 0 failed (vitest 42.59 s) | 44 s (CI step budget 3 min: within) | 0 |
| `pnpm -r typecheck` | `packages/contract typecheck: Done`, `scripts typecheck: Done` | n/a | 0 |
| `pnpm -r lint` | both packages Done | n/a | 0 |
| `pnpm lint:root` | `eslint .` no findings | n/a | 0 |
| `pnpm format:check` | "All matched files use Prettier code style!" | n/a | 0 |

Change since 61811a7 and 842e199: the default `scripts` run is now 18 files / 232 passed because every `scripts/test/sprint-*.test.ts` moved to `test:sprint` (a2ac93d; `test:sprint-ps` is kept as an alias). `scripts/test/test-split.test.ts` (default run) guards that each test file is in exactly one run. The earlier `test:sprint-ps` result (3 files, 79 passed, 42 s) is superseded. At 842e199 the single `pnpm -r test` held 26 scripts files / 419 passed; now 232 plus 279 sprint tests are split over two commands. The 13 contract skips and 3 scripts skips are the same classes as listed above (S0 pending-fixture skips; symlink or POSIX platform skips).

Local working tree at the time of the run: `git status --short` shows only `docs/VERIFY-P0.md` and `docs/sessions/p0-sprint-tooling.md` modified; no code differs from commit 33bde60.

### E1b: CI evidence at 33bde60 (`gh run view <id> --json conclusion,jobs`, `gh pr checks 2`)

Push run 38651763604: conclusion success, headSha 33bde60, all four jobs success. Pull_request run 38651770843: conclusion success, all four jobs success. `gh pr checks 2` lists all eight checks (two runs by four jobs) as pass. Step durations from startedAt and completedAt (UTC, 2026-10-14):

| Run | Job | "test (R0.5 budget 60 s)" | "test sprint tooling (budget 3 min, separate from R0.5)" |
|---|---|---|---|
| push | ubuntu node 22 | 16 s | 67 s |
| push | ubuntu node 24 | 15 s | 68 s |
| push | windows node 22 | 36 s | 112 s |
| push | windows node 24 | 31 s | 91 s |
| pull_request | ubuntu node 22 | 21 s | 78 s |
| pull_request | ubuntu node 24 | 12 s | 63 s |
| pull_request | windows node 22 | 27 s | 76 s |
| pull_request | windows node 24 | 32 s | 97 s |

Test counts from the step logs (`gh run view <id> --log`, both runs agree):

| Platform | R0.5 step: contract | R0.5 step: scripts | Sprint tooling step |
|---|---|---|---|
| ubuntu (node 22 and 24) | 22 files, 433 passed | 17 files, 231 passed | 13 files, 278 passed |
| windows (node 22 and 24) | 22 files, 434 passed | 18 files, 232 passed | 13 files, 279 passed |

The one-test difference per suite is a platform-specific test selection. Longest R0.5 step 36 s (limit 60 s); longest sprint step 112 s (limit 3 min). Job totals in `gh pr checks`: push 1m59s, 2m0s, 4m13s, 3m14s; pull_request 2m21s, 1m46s, 2m47s, 3m24s.

History, not current: at 61811a7 the pull_request run 38646834253 failed once on windows-latest node 22 because the single R0.5 step hit the 60 s limit (the scripts suite was still running; no assertion failed), while the push run 38646827327 of the same commit passed that job in 36 s. a2ac93d answers that by moving the sprint tooling tests into their own CI step. Orchestrator decision 24 (session log): the R0.5 step now runs the contract suite and S0's scripts tests only. The user is asked about this as an open question; this file records the R0.5 evidence factually: `pnpm -r test` under 60 s holds locally (11 to 12 s) and in CI (12 to 36 s), and the sprint tooling tests (279 on Windows) are measured separately against a 3 minute step budget.

Review verdicts as recorded by the orchestrator (not re-run): a6e9510 sd-reviewer merge, sd-security-reviewer "Gate: pass (whole branch at a6e9510)"; a2ac93d and 0966704 sd-reviewer merge, sd-security-reviewer "Gate: pass for the whole branch at 0966704" with one LOW (bare-name shell fallback on Windows, hardening for later); 0d2ef5b and 33bde60 sd-reviewer merge at 33bde60 with one MINOR deferred (`scripts/test/fixtures/sprint-ps/harness.ts:52` probe error code can name pwsh's ENOENT when powershell.exe exited non-zero). Earlier MINOR still deferred: `discardTemp` says "temp file not removed (ENOTDIR)" when no temp file was created (a6e9510 treats ENOTDIR as nothing to remove in `scripts/sprint/render-prompt.mjs` and `packages/contract/src/state-file-atomic.ts`).

Note on "verified by CI": the S0c rows verified by local runs (R0.8 renderer, state-file helper, handoff rows for the PowerShell scripts) are also backed by CI at 33bde60: push and pull_request runs both green on all four jobs. The container rows (Dockerfile, compose, entrypoint, stop) and the placeholder smoke run are not CI-covered (CI has no image build). The R0.5 S0 row (run 37890035505 at 16ff347) is unchanged. The live smoke row stayed "needs laptop confirmation (live tokens)" at that time; it became pass on the laptop run of 2026-10-15 (S0b section).

### E2: container harness (cited, not re-run; image not rebuilt)

Still valid at 33bde60: `git diff --stat b4b8177..33bde60 -- infra/sprint scripts/sprint` lists only `infra/sprint/README.md` (Testing section, after every README line cited in this file) and `scripts/sprint/render-prompt.mjs` (ENOTDIR as "nothing to remove" in temp cleanup; the renderer runs on the host, not in the image). No Dockerfile, compose, entrypoint or `scripts/sprint/*.ps1` change, so E2 and E5 are cited, not re-run. Run by the orchestrator at b4b8177 after a fresh image build: `bash infra/sprint/test/check-sprint-image.sh C:/Users/stack/projects/sessiondeck/.sprint/0/screens/S0c`, exit 0. Evidence file `C:/Users/stack/projects/sessiondeck/.sprint/0/screens/S0c/u2-container-check.txt` (written 2026-10-14 17:38 EDT) read in this pass: 103 `PASS` lines, 0 `FAIL` lines, last line `result: 0 failure(s)`. Image `sessiondeck-sprint:local` id `bfb55e2edf3e` (confirmed by `docker image inspect`: created 2026-10-14T21:37:26Z). PASS counts by check: 1 compose 7 lines, 2 and 3 and 4 per run (uid, writable mounts, socket reach, argv, status.json green on host), 5 root refused / non-root auth error 2, 6 secrets 8, 7 guards 34, 8 clone then fetch 2, 9 shellcheck 2, 10 SIGTERM 3. Tail:

```
PASS  10 entrypoint logged the forwarded stop: 1
PASS  10 container exit code after docker stop: 143
PASS  10 stopped within the grace period: 1s of 15s
cleanup: removing containers, volume and temp directory created here
result: 0 failure(s); output copy at C:/Users/stack/projects/sessiondeck/.sprint/0/screens/S0c/u2-container-check.txt
```

### E3: renderer

`node scripts/sprint/render-prompt.mjs --sprint <id> --contract-sha 0123abc (ids 1 to 5; 0 and smoke without it)` for each id, exit 0 each: 0 gives 54 lines, 1 gives 61, 2 gives 54, 3 gives 55, 4 gives 58, 5 gives 56, smoke gives 1. `--sprint 9` exits 2: `unknown sprint "9"; valid ids: 0, 1, 2, 3, 4, 5, smoke`. Unfilled-placeholder scan: only `{SESSION_ID}` and `{SESSION_BRANCH}` (pass-through by design, `scripts/sprint/lib/fill-template.mjs:6`) and the literal `${CLAUDE_PROJECT_DIR}` in package 0 text. Unit tests: `pnpm exec vitest run -c vitest.sprint.config.ts test/sprint-render` in `scripts/` (inside `test:sprint` since a2ac93d): 7 files, 126 passed. Re-run at 33bde60: exit 0 for ids 0, 1 to 5 and smoke; line counts unchanged (54, 61, 54, 55, 58, 56, 1).

### E5: placeholder smoke run (refreshed)

Command (from `powershell.exe -File`, existing image, no `-Build`): `scripts/sprint/smoke-check.ps1 -EnvFile <temp>\env -StateRoot <temp>\state -RepoRoot C:\Users\stack\projects\wt\S0c`, where the env file held two lines of `placeholder-not-a-token`. `C:/Users/stack/projects/sessiondeck/.sprint/env` was never created or read. Output file refreshed at `C:/Users/stack/projects/sessiondeck/.sprint/0/screens/S0c/u5-smoke-placeholder.txt`. Exit 1, `RESULT: FAIL` at the clone step, which is the expected outcome with placeholders:

```
=== smoke check evidence ===
RESULT: FAIL
start_seconds: 1.8 (run-sprint, including any image build)
wait_seconds: 3.4 (limit 120, counted after run-sprint returned)
image sessiondeck-sprint:local: present (reused, no build)
final_state: no status.json
container: exited, exit code 128
run-sprint exit: 0
stop-sprint: ran, exit 0
entrypoint: start: sprint=smoke uid=1000 gid=1000 groups=1000,0
entrypoint: tokens present: CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN (values never logged)
entrypoint: clone path: cloning into /work
entrypoint: failed at line 216 with status 128 during clone: check that GH_TOKEN has access to this repository, SPRINT_REPO_URL, and the network
```

Proven by this run: the container starts as non-root (uid 1000), the tokens reach it only through the env file, the entrypoint log names the variables and never a value (the placeholder string appears in none of the state files; the env file itself was the only holder), stop works. Cleanup: `docker ps -a --filter name=sd-0-S0c --filter name=sprint-smoke` is empty; the temp directory was removed by exact path. The named volume `sprint-smoke-work` from earlier runs still exists (the script keeps it by design; remove with `docker volume rm sprint-smoke-work` for a fresh clone). I started no container of my own; the smoke script names its container `sprint-smoke`.

### E6: tokens only via `.sprint/env`

- Static: `sprint-image-static.test.ts` `:114` (entrypoint never echoes a token value), `:225` and `:233` (output goes through the token filter, secrets read from the environment, never argv), `:490` (no ARG or ENV naming a token), `:554` and `:558` (compose reads tokens through an overridable env_file and does not interpolate them), `sprint-ps-static.test.ts:47` (the PowerShell scripts never read the env file). All pass in the 279 sprint tooling tests (`test:sprint`; these files left the default run in a2ac93d), verified by CI on both OSes at 33bde60.
- Harness check 6 (E2): 0 matches of the placeholder tokens in docker logs, `/state/<id>/logs/*`, `sprint.jsonl`, `~/.gitconfig`, `/work/.git/config` and `docker history --no-trunc`; the `[REDACTED]` marker appears in docker logs (2 lines) and `sprint.jsonl` (1 line); check 7 shows 34 environment guards refusing anything else with exit 64.
- Repo grep: `git grep -nIE "sk-ant-...|gh[pousr]_...|github_pat_..."` over all tracked files returned 0 matches. References to `.sprint/env` outside docs are the compose `env_file` default (`infra/sprint/docker-compose.yml:21`), comments and refusal messages in the pre-stage, and `scripts/sprint/run-sprint.ps1:120-150` which resolves the path, tests that it exists and reads its ACL only. `scripts/sprint` has no `Get-Content`, hash or copy call. `.gitignore:18` ignores `.sprint/`.

### Unverified here

- Real-token smoke (green within 120 s): was laptop only; resolved by the laptop run of 2026-10-15 (S0b section, laptop confirmations).
- Deferred review findings (not fails): LOW bare-name shell fallback on Windows (hardening for later); MINOR `scripts/test/fixtures/sprint-ps/harness.ts:52` probe error code; MINOR `discardTemp` wording; LOW token-start rule in `state-file-secrets.ts:40`.
- Not observed: a rejected or expired token's message; `--agent` with `-p` and a project-scoped agent (README `:129-131`).
- GitHub token scope details are marked in the README as unchecked against GitHub's page.
- User decision on the docker socket (accept, proxy, ECI or rootless DinD) is open; README `:50` says it must be made before writing `.sprint/env`.

## S0b: fixtures and reducer finalization (R0.1, R0.2, R0.3, R0.4, R0.7, plus the laptop confirmations)

- Branch `p0/fixtures`, HEAD 21da7db ("test(contract): compute CONTRACT.md observed table once per file (R0.5, R0.7)"), clean tree before this file was edited. Phase doc `docs/planning/phases/phase-0-contract.md`; handoff `docs/handoffs/S00b-fixtures-and-reducer-finalization.md`; session log `docs/sessions/p0-fixtures.md`.
- Date (UTC): 2026-10-16, runs 05:00Z to 05:10Z. Machine: Windows 11 Home 10.0.26200, Git Bash, Node v24.19.0, pnpm 12.10.1 (versions as in the S0 pass; not re-queried). Commands run sequentially from the repo root, one at a time, nothing in the background.
- Verifier: sd-verifier. Handled with care: nothing under `packages/contract/fixtures/raw/` was read (only an entry count), and neither `.sprint/env` nor `.sprint/smoke/logs/` was opened.

### Synthetic fixtures note (2026-10-16)

TaskCreated, TaskCompleted, PermissionDenied and StopFailure were not captured. Conductor decision 7: task tools are disabled on this machine (no task events), the capture ran in default permission mode (so no denial), and no StopFailure occurred. Their five files under `packages/contract/fixtures/synthetic/` are marked synthetic, are walked and reported separately by the envelope walk, and are not counted toward the captured totals (176 hook fixtures, 13 events). Affected rows: R0.3 clause 4 (StopFailure), R0.7 count, R0.1 walk. TaskCreated and TaskCompleted reducer behavior stays provisional (session log U3).

### Commands run at 21da7db

| Command | Key output | Wall | Exit |
|---|---|---|---|
| `pnpm -r test` | contract: 27 files, 1048 passed / 0 skipped / 0 failed (vitest 21.35 s); scripts: 25 files, 418 passed / 3 skipped / 0 failed (vitest 23.83 s). R0.5 budget 60 s: within | 27.2 s | 0 |
| `pnpm -r typecheck` | `packages/contract typecheck: Done`, `scripts typecheck: Done` | 11.7 s | 0 |
| `pnpm -r lint` | both packages Done | 6.8 s | 0 |
| `pnpm -F @sessiondeck/contract gen:doc -- --check` | `docs/CONTRACT.md is up to date.` | 2.4 s | 0 |
| `pnpm -F @sessiondeck/scripts run fixture:leak` | `mode: raw-derived literals + patterns`, `files scanned: 213`, `derived literals: users=1 projects=20 names=45 (skipped short=1)`, `PASS: no leaks found` | 18.0 s | 0 |
| contract coverage: the contract `test` script, `vitest run --coverage` (part of `pnpm -r test`; per-file `lines: 100` thresholds in `packages/contract/vitest.config.ts`) | line coverage: `state.ts` 100, `envelope.ts` 100, `transitions.ts` 100 (also 100 on statements, branches and functions); all files 98.83 lines; no threshold failure | within the 27.2 s | 0 |

Wall times for the last four commands were taken from a second timing run of the same commands (the first run, whose output is quoted, did not record wall time); both runs exited 0 with identical output. The targeted `pnpm exec vitest run <files> --coverage.enabled=false` runs quoted in the rows (envelope-walk plus envelope 534 passed; statusline 44; state, state-fixtures and state-golden 106; fixtures-counts 7) all passed with 0 skipped.

Tail of `pnpm -r test` (ANSI removed):

```
packages/contract test:  state.ts          |     100 |      100 |     100 |     100 |
packages/contract test:  statusline.ts     |     100 |      100 |     100 |     100 |
packages/contract test:  tracking.ts       |     100 |      100 |     100 |     100 |
packages/contract test:  transcript.ts     |       0 |        0 |       0 |       0 |
packages/contract test:  transitions.ts    |     100 |      100 |     100 |     100 |
packages/contract test:  wire.ts           |     100 |      100 |     100 |     100 |
packages/contract test: Done
scripts test:  Test Files  25 passed (25)
scripts test:       Tests  418 passed | 3 skipped (421)
scripts test:    Duration  23.83s (transform 4.62s, setup 0ms, collect 25.72s, tests 187.80s, environment 7ms, prepare 13.98s)
scripts test: Done
real	0m27.197s
```

Note on the scripts counts: the S0c section reports scripts 18 files / 232 passed because the sprint tooling tests lived in `test:sprint`; at 21da7db `pnpm -r test` reports 25 files / 418 passed / 3 skipped (the verifier did not investigate the difference; S0b's own sessions added scripts tests, session log U1 to U3 "scripts 418 pass"). `pnpm -F @sessiondeck/scripts test:sprint` was not run in this pass, so the S0c sprint tooling rows keep their 33bde60 evidence.

### Laptop confirmations (2026-10-15, from the conductor; recorded, not re-run by the verifier)

(a) R0.8 live smoke run with real tokens: PASS on 2026-10-15, status green 16.2 s after container start. Evidence file `C:/Users/stack/projects/sessiondeck/.sprint/0/gate/smoke-evidence-run2.txt` (read in this pass; 1,631 bytes; nothing token-shaped in it), quoted in full:

```
=== smoke check evidence ===
RESULT: PASS
start_seconds: 2.8 (run-sprint, including any image build)
wait_seconds: 16.2 (limit 180, counted after run-sprint returned)
image sessiondeck-sprint:local: present (reused, no build)
final_state: green
container: running
run-sprint exit: 0
stop-sprint: ran, exit 0
--- last 20 lines of C:\Users\stack\projects\sessiondeck\.sprint\smoke\logs\entrypoint.log (printable ASCII only) ---
2026-10-15T14:29:23Z entrypoint: start: sprint=smoke uid=1000 gid=1000 groups=1000,0
2026-10-15T14:29:23Z entrypoint: tokens present: CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN (values never logged)
2026-10-15T14:29:23Z entrypoint: clone path: cloning into /work
2026-10-15T14:29:24Z entrypoint: checkout: sprint branch '' not on the remote, using default branch main
2026-10-15T14:29:24Z entrypoint: launching claude headless; stream goes to /state/smoke/logs/sprint.jsonl
2026-10-15T14:29:29Z entrypoint: claude exited with status 1
2026-10-15T15:00:39Z entrypoint: start: sprint=smoke uid=1000 gid=1000 groups=1000,0
2026-10-15T15:00:39Z entrypoint: tokens present: CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN (values never logged)
2026-10-15T15:00:39Z entrypoint: fetch path: /work is already a clone
2026-10-15T15:00:41Z entrypoint: checkout: sprint branch '' not on the remote, using default branch main
2026-10-15T15:00:41Z entrypoint: launching claude headless; stream goes to /state/smoke/logs/sprint.jsonl
2026-10-15T15:00:56Z entrypoint: claude exited with status 143
---
NOTE: the entrypoint log and docker logs can hold secrets. Read them yourself; do not paste them into a chat or an issue.
=== end evidence ===
```

Reading of the evidence: the file shows RESULT: PASS with final_state green and wait_seconds 16.2 (limit 180 in the script, looser than the requirement's 120 s; 2.8 s plus 16.2 s is about 19 s, inside 120 s). The entrypoint log lists two container runs: 14:29 (claude exited with status 1) and 15:00 (claude exited with status 143, a SIGTERM stop). The file does not say which run produced the PASS and does not show the content of `status.json`; the green state comes from its `final_state: green` line.

(b) Capture installer, real install and uninstall (2026-10-15, conductor, from a plain terminal): backups written beside the user-level settings file; the exec-form hooks fire on Windows 11 Home 10.0.26200 with Claude Code 2.1.301; no `_capture-errors.log` was produced. This closes the "exec form fires on Windows" laptop item from the S0 harness (which proved the installer only inside a sandbox). Recorded, not re-run.

(c) The project guard hook (`.claude/hooks/guard.mjs`) still fires with the capture hook installed (conductor, 2026-10-15). This also answers the needs_laptop item "verify guard.mjs fires via `${CLAUDE_PROJECT_DIR}` in exec form". Recorded, not re-run.

### Requirement results at 21da7db

| Requirement | Result | Where |
|---|---|---|
| R0.1 | pass | rows R0.1 (two rows), re-confirmed from 9839118 |
| R0.2 | pass | rows R0.2 (purity with frozen inputs; golden timeline: 295 events, 11 changes, final ended/clear, hand-verified 11/11 twice by sd-reviewer) |
| R0.3 | pass | seven clause rows; captured sequences for clauses 1, 2, 3, 5; clause 4 (StopFailure), 6 (liveness dead) and 7 (same pid) are synthetic only |
| R0.4 | pass | statusLine rows, re-confirmed from 9839118 |
| R0.7 | pass | fixture-count row, re-confirmed from bdcbaca; tooling and ignore rows are S0 and unchanged |
| R0.8 (live) | pass | laptop run 2026-10-15 above |

### Not verified in this pass

- Hand verification of the golden timeline (11 changes): cited from sd-reviewer in the session log, not repeated.
- Laptop items (a to c): recorded from the conductor; the verifier read only the evidence file for (a).
- `pnpm -F @sessiondeck/scripts test:sprint` and CI at 21da7db (no CI run on this commit was queried); the container harness was not re-run.
- U4b: `.claude/` changes ship only as `docs/patches/S0b-claude-dir.patch`, not applied, so the guard rule for `capture-install.mjs --apply` and the Read deny rule on the capture directory are not in force in the repo. The user applies the patch.
- Open question recorded in the session log: `docs/planning/01-architecture.md:103` still lists PostToolUseFailure under error; a vault and repo edit is for the user.

### Totals (S0b)

Requirement rows touched by S0b: R0.1 (2), R0.2 (2), R0.3 (7), R0.4 (1), R0.7 (1), R0.8 (2): 15 rows, 15 pass / 0 fail / 0 pending. Definition of done rows touched: coverage, CONTRACT.md, sd-reviewer, sd-security-reviewer fixtures: 4 pass; U4b patch applied: open (user step). No row in this file is pending.

## FIX-1 (sprint/0-bootstrap, 77b493e)

Verifier run of 2026-10-16, 07:06Z to 07:13Z, worktree `C:/Users/stack/projects/wt/FIX-1`, HEAD 77b493e, 20 logical cores. Scope: R0.5 verification and R0.1 to R0.4, R0.7 re-verification after the test-runner changes in 565ab0d, 7237cd5, 1ec6e2c, 77b493e. Existing rows above are unchanged. `.sprint/0/gate/fix-1-ci.txt` was checked against `gh` output (all four step durations match).

| Req | Command | Key output | Result | Timestamp |
|-----|---------|------------|--------|-----------|
| R0.5 (CI) | `gh run view 38864962895 --json conclusion,headSha,jobs` | run success, headSha 77b493e; all 4 jobs success. Step "test (R0.5 budget 60 s)": windows node 24 26 s, windows node 22 31 s, ubuntu node 24 15 s, ubuntu node 22 16 s (all under 60 s) | pass | 07:06Z run time |
| R0.5 (local, 5 runs) | `time pnpm -r test` x5 | run 1: exit 1, 13.7 s, contract `state-file-cli.test.ts > init creates the layout, write-session merges...` (3 spawned processes in one test) failed with "Test timed out in 5000ms" (1090 passed / 1 failed). Runs 2 to 5: exit 0, 13.9 / 14.0 / 13.6 / 13.3 s, contract 1091 passed, scripts 464 passed / 3 skipped. The same test took 1586 ms in a later isolated contract run | fail (intermittent red on the proving command: 1 of 5 local runs; CI 4 of 4 green) | 07:10Z to 07:11Z |
| R0.1 | `pnpm -F @sessiondeck/contract test`; `pnpm exec vitest run test/envelope-walk.test.ts test/envelope.test.ts --coverage.enabled=false` | contract 28 files, 1091 passed / 0 failed / 0 skipped, exit 0; envelope-walk + envelope 534 passed; with statusline 578 passed; envelope.ts 100 % lines | pass | 07:12Z |
| R0.2 | `pnpm exec vitest run test/state.test.ts test/state-fixtures.test.ts test/state-golden.test.ts --coverage.enabled=false` | 106 passed, 0 failed, 0 skipped; state.ts 100 % lines and branches | pass | 07:12Z |
| R0.3 | same command as R0.2 | 106 passed (clauses 1 to 7, same files as the R0.3 rows above) | pass | 07:12Z |
| R0.4 | `pnpm exec vitest run test/statusline.test.ts --coverage.enabled=false` | 44 passed, 0 failed, 0 skipped; statusline.ts 100 % | pass | 07:12Z |
| R0.1 to R0.4 coverage | `pnpm -F @sessiondeck/contract test` (exit 0, thresholds in `packages/contract/vitest.config.ts` met) | all files 98.83 % lines; envelope.ts, state.ts, statusline.ts, transitions.ts, snapshot.ts and the other thresholded files 100 %; guard `test/isolate-guard.test.ts` passes | pass | 07:11Z |
| R0.7 leak gate | `pnpm -F @sessiondeck/scripts fixture:leak` | `files scanned: 213`, `PASS: no leaks found`, exit 0. Caveat: mode was `patterns only (no raw/)` because the gitignored `raw/` directory does not exist in this worktree; the earlier S0b run was `raw-derived literals + patterns`. The 213 tracked files are the same count | pass (patterns mode only) | 07:12Z |
| R0.7 scripts suite | `pnpm -F @sessiondeck/scripts test` | 27 files, 464 passed / 3 skipped (platform skips) / 0 failed | pass | 07:12Z |
| R0.7 fixture counts | `pnpm exec vitest run test/fixtures-counts.test.ts --coverage.enabled=false` in packages/contract; `git ls-files packages/contract/fixtures \| grep -c /raw/` | 7 passed (asserts at least 50 fixtures over at least 12 events, 20 statusLine samples); tracked raw/ paths: 0 | pass | 07:12Z |
| R0.8 (count only, not re-verified) | `pnpm -F @sessiondeck/scripts test:sprint` | 13 files, 279 passed / 0 failed, 53 s | not re-verified | 07:13Z |

FIX-1 result: 7 pass / 1 fail (R0.5 local flake) / 0 unverifiable, plus the R0.8 count.

## FIX-1 re-verify (sprint/0-bootstrap, 543aa73)

Verifier run of 2026-10-16, 07:30Z to 07:40Z, worktree `C:/Users/stack/projects/wt/FIX-1`, HEAD 543aa73. Scope: R0.5 (previous local flake in `packages/contract/test/state-file-cli.test.ts`) and R0.1 to R0.4 (contract test files changed). R0.7 not re-run (scripts unchanged). Existing rows above are unchanged.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R0.5 CI | `gh run view 38867610820 --json conclusion,headSha,jobs`; cross-check `.sprint/0/gate/fix-1-ci.txt` FINAL block | conclusion success; headSha 543aa7306fbeff23981c465daa31f9683df5afdf; 4/4 jobs success. "test (R0.5 budget 60 s)" step: windows node 24 21 s (07:31:23Z to 07:31:44Z), windows node 22 28 s (07:31:30Z to 07:31:58Z), ubuntu node 24 11 s, ubuntu node 22 16 s. All match the txt file | pass | 07:31Z run, checked 07:35Z |
| R0.5 local | `pnpm -r test` x10 in a row, timed with `date +%s%N` | 10/10 exit 0, no failed or timed-out test in any log. Wall ms: 11804, 10972, 11399, 11597, 11533, 11151, 11065, 11283, 11311, 11292; min 10.97 s, median 11.30 s, max 11.80 s (budget 60 s). Contract 1091 passed, scripts 464 passed / 3 skipped | pass | 07:35Z |
| R0.1 | `pnpm -F @sessiondeck/contract test`; `pnpm exec vitest run test/envelope-walk.test.ts test/envelope.test.ts test/statusline.test.ts --coverage.enabled=false` | contract 28 files, 1091 passed / 0 failed, exit 0, coverage thresholds met (no threshold error), envelope.ts 100 %; per-file run 578 passed | pass | 07:36Z |
| R0.2 | `pnpm exec vitest run test/state.test.ts test/state-fixtures.test.ts test/state-golden.test.ts --coverage.enabled=false` | 3 files, 106 passed, 0 failed; state.ts 100 % in the full run | pass | 07:36Z |
| R0.3 | same command as R0.2 | 106 passed (clauses 1 to 7; clauses 4, 6, 7 synthetic as in the rows above) | pass | 07:36Z |
| R0.4 | `pnpm exec vitest run test/statusline.test.ts --coverage.enabled=false` (inside the R0.1 3-file run) | statusline.ts 100 %; 578 passed in the combined run (44 statusline as before) | pass | 07:36Z |

FIX-1 re-verify result: 6 pass / 0 fail / 0 unverifiable.

## FIX-2 (sprint/0-bootstrap, 0ed9f9e)

Verifier run of 2026-10-19, 21:40Z to 21:45Z, worktree `C:/Users/stack/projects/wt/FIX-1`, HEAD 0ed9f9e (clean, not pushed), Node v24.19.0, Windows 11. Scope: R0.5 (test split, decision 13), R0.6, the guard rows, and the notes for decisions 9, 10, 11. Existing rows above are unchanged. Each command ran once; no 4-core proxy; the guard patch was only checked with `git apply --check`, never applied.

Note on the split (decision 13, user, 2026-10-19; same pattern as decision 2 in the S0c section): the default `vitest.config.ts` excludes `test/guard-timing*.test.ts` (`scripts/vitest.config.ts:27`), so `pnpm -r test` (R0.5, 60 s budget) runs no timing file. `scripts/vitest.guard-timing.config.ts` includes exactly that glob and runs it in its own CI step with bounded retries of timing failures only (`scripts/ci/guard-timing-retry.mjs`). Functional guard tests (`guard-rules.test.ts`) and the retry classifier (`guard-retry-classify.test.ts`) stay in the default run. `scripts/test/test-split.test.ts` proves every test file is in exactly one of the three runs (default, sprint, guard timing).

| Requirement | Command | Key output | Result | Timestamp (UTC) |
|---|---|---|---|---|
| R0.5 local: `pnpm -r test` inside 60 s | `pnpm -r test`, timed with `date +%s%N` | exit 0, wall 18.85 s (budget 60 s). contract 28 files, 1091 passed. scripts 29 files, 575 passed / 4 skipped (579). No `guard-timing*.test.ts` file ran: `grep guard-timing` on the log finds nothing; the only guard files were `guard-rules.test.ts` and `guard-retry-classify.test.ts` | pass | 2026-10-19 21:41Z |
| R0.5 CI | not run: HEAD is not pushed | pending CI run of the pushed head; recorded in `C:/Users/stack/projects/sessiondeck/.sprint/0/gate/fix-2-ci.txt` | unverifiable (pending CI) | 2026-10-19 21:45Z |
| R0.5 split (decision 13) | read `scripts/vitest.config.ts`, `scripts/vitest.guard-timing.config.ts`, `.github/workflows/ci.yml`, root `package.json`; grep for `continue-on-error` in ci.yml; `test-split.test.ts` ran in the `pnpm -r test` row | default config `exclude` has `GUARD_TIMING_TESTS` (`vitest.config.ts:27`); guard-timing config `include: [GUARD_TIMING_TESTS]`; `test-split.test.ts` 7 passed (incl. "puts every test file in exactly one run", `:59`, and "keeps the functional guard tests and the retry classifier tests in the default run", `:80`); ci.yml:46 step `test guard timing (outside R0.5 budget, up to 3 attempts)` with `timeout-minutes: 7` (:53), runs `pnpm -F @sessiondeck/scripts test:guard-timing:ci` (:52); no `continue-on-error` anywhere in ci.yml; root `ci` script contains `pnpm -F @sessiondeck/scripts test:guard-timing:ci` | pass | 2026-10-19 21:41Z |
| R0.5 guard timing run | `pnpm -F @sessiondeck/scripts test:guard-timing:ci` | exit 0; `guard timing attempt 1 of 3: pass (44 passed)`; `guard timing: passed after 1 attempt(s), 16.1 s`; 2 files (`guard-timing.test.ts` 20, `guard-timing-helper.test.ts` 24), 44 passed / 0 failed. Worst row (highest match, work and raw ms), `node + tabs + capture-install --apply`: `match 2.6 ms (calls 8), scriptMs 10.8, rawMs 10.8 (bound 3000), stdinWaitMs 6.3, stdinIdleMs 0.1, workMs 10.7, execMs 0.0, execCalls 0, wall 262 ms (not a bound), status 2` (bounds: matchMs 150, workMs 300, rawMs 3000). Slowest exec row, `git push + spaces`: `scriptMs 121.7, rawMs 8.4, workMs 8.2, execMs 113.3, execCalls 1` | pass | 2026-10-19 21:42Z |
| R0.5 retry classifier | `scripts/test/guard-retry-classify.test.ts`, in the default run | 19 passed. Retry only when every failure is a TimingBoundError: `:61` "retries when every failed test failed on a timing bound". No retry on mixed or functional failure: `:75` mixed, `:82` functional (status, call count, exec command, hang, listener), `:94` timing plus other message, `:99` prefix not at start. Cap 3: `:162` "uses at most 3 attempts", `:181` "stops after the 3rd timing failure", `:189` "never exceeds the cap". Missing or unparseable JSON fails: `:104` missing or empty, `:110` unparseable or unexpected shape; also `:116` no tests ran, `:120` exit code disagrees, `:126` suite-level failure | pass | 2026-10-19 21:41Z |
| R0.5 guard functional rows (incl. push rows) | `scripts/test/guard-rules.test.ts`, in the default run | `guard-rules.test.ts (91 tests \| 1 skipped)`, 0 failed, so 90 passed. Push describe `:238`: blocked force and main forms `:250` (6 rows: `--force`, `-f` and `--force-with-lease` with "force push is forbidden"; push to `origin main`, `origin HEAD:main` and `git status; ...origin main` with "pushing to main is forbidden"); feature-x allowed `:256`; bare push derived from `git rev-parse --abbrev-ref HEAD` `:263` | pass | 2026-10-19 21:41Z |
| R0.5 guard timing content | `scripts/test/guard-timing.test.ts`, names from the guard timing run above | execCommands pinned: `:115` `expect(run.execCommands).toEqual(Array(expected.execCalls).fill(GUARD_EXEC_COMMAND))`, `GUARD_EXEC_COMMAND = "git rev-parse --abbrev-ref HEAD"` (`helpers/guard-timing.ts:112`); passed: "pins the execSync command: a different command fails the deterministic check", "counts and excludes execSync through the named ESM import". Exit listener: "catches sync work in an exit listener added after the preload's, without a retry" (`:196`) passed. rawMs bound `MAX_RAW_SCRIPT_MS = 3000` (`helpers/guard-timing.ts:76`), used `:93`, `:246`, `:258`; delayed-read self-tests (`:237`) passed: "rejects a guard that idles before reading stdin through the raw time: timer" (`scriptMs 3619.8, stdinIdleMs 3612.7, workMs 7.1`) and "...: exec" (`scriptMs 3724.6, stdinIdleMs 3689.1, workMs 35.4`), both over the 3000 ms raw bound while workMs stays small | pass | 2026-10-19 21:42Z |
| Guard patch (hash and apply) | `git apply --check docs/patches/FIX-2-guard.patch`; `git hash-object docs/patches/FIX-2-guard.patch` | apply --check: silent, exit 0. hash `f561a484f3b7759fccad3736d0c29253d70946ae` equals the hash in `docs/patches/README.md:90` | pass | 2026-10-19 21:43Z |
| Guard patch (patched run results) | not re-run by the verifier; recorded in `docs/sessions/sprint-0-fix-2.md` "U3 step 2b" (line 132) and "U3 step 2 fix round" (line 141) | with the patch applied in a temporary worktree by the executor: default run scripts 578 passed / 4 skipped (29 files), contract 1091, 19.0 s; `test:guard-timing:ci` passed on attempt 1, 81 tests, 3 files, 22.4 s. Recorded, not verified here | unverifiable (recorded, not re-run) | n/a |
| Guard patch applied on the branch | `git apply --check` only | patch not applied on the branch: user step (`docs/patches/README.md`). Until then the branch runs the 44-test guard timing run above, not the 81-test patched run | open (user step) | 2026-10-19 21:43Z |
| R0.6 | `diff -rq --strip-trailing-cr C:/Users/stack/vault/projects/sessiondeck/planning docs/planning`; `sed -n 103p` of both `01-architecture.md` | diff printed nothing, exit 0. Both copies, line 103: `\| 'error'  // StopFailure (API errors arrive as StopFailure)` (decision 10) | pass | 2026-10-19 21:43Z |
| Decision 9 (note, not re-run) | read `docs/sessions/p0-fixtures.md:111` | idle rule kept: a background subagent's tool call does not move an idle session back to working. Relates to the R0.2 golden row at `VERIFY-P0.md:19` ("no subagent event leaves idle or waiting_input"). No code change | pass (note) | 2026-10-19 21:43Z |
| Decision 10 (note, not re-run) | read `docs/sessions/sprint-0-fix-2.md` Docs unit, `VERIFY-P0.md:338`, 01-architecture.md:103 | resolves the open item at `VERIFY-P0.md:338` (line 103 listed PostToolUseFailure under error); line 103 now reads StopFailure only. That earlier row stays as written | pass (note) | 2026-10-19 21:43Z |
| Decision 11 (note, not re-run) | read `docs/ENVIRONMENT.md:8` | `Plan type \| Max (decision 11, user, 2026-10-19)` | pass (note) | 2026-10-19 21:43Z |
| Typecheck | `pnpm -r typecheck` | exit 0, contract and scripts `Done` | pass | 2026-10-19 21:44Z |
| Lint (packages) | `pnpm -r lint` | exit 0, contract and scripts `Done` | pass | 2026-10-19 21:44Z |
| Lint (root) | `pnpm lint:root` | exit 0, no findings | pass | 2026-10-19 21:44Z |
| Format | `pnpm format:check` | exit 0, `All matched files use Prettier code style!` | pass | 2026-10-19 21:44Z |

FIX-2 result: 15 pass (incl. 3 notes) / 0 fail / 3 unverifiable or open (R0.5 CI pending, patched run recorded not re-run, patch not applied on the branch: user step).

DOCS-1 verification (2026-10-19, branch sprint/0-bootstrap, worktree `C:/Users/stack/projects/wt/FIX-1`, head cd2f9da, range 1e83925..cd2f9da, docs-only: harbor-last sprint order, ADR 0010).

| Requirement | Command | Key output | Result | Timestamp (UTC) |
|---|---|---|---|---|
| R0.6 (DOCS-1, head cd2f9da) | `diff -rq --strip-trailing-cr C:/Users/stack/vault/projects/sessiondeck/planning C:/Users/stack/projects/wt/FIX-1/docs/planning`; supporting: `pnpm -F @sessiondeck/scripts test:sprint`; `node scripts/sprint/render-prompt.mjs --sprint 4 --contract-sha 0000000` and `--sprint 5 ...`, grepped; `pnpm format:check` | diff printed nothing, exit 0. `test:sprint`: 13 files passed, 279 tests passed, 0 failed. Render sprint 4 exit 0 (64 lines): `linux/arm64` x2 (lines 30, 40), `S13 runner security re-review` x1 (line 31), `laptop hub` x1. Render sprint 5 exit 0 (58 lines): `laptop hub` x3 (lines 27, 29, 35); `linux/arm64` and `S13 runner security re-review` x0 (they sit in sprint 4 only). `format:check`: `All matched files use Prettier code style!`, exit 0 | pass | 2026-10-19 |

## ENV-1 (p0/environment, 2026-10-19)

ENV-1 verification (2026-10-19, branch p0/environment, worktree `C:/Users/stack/projects/wt/ENV-1`, head d7f91d5, docs-only: ENVIRONMENT.md filled, WSL2 moved into Phase 1).

| Requirement | Command | Key output | Result | Timestamp (UTC) |
|---|---|---|---|---|
| R0.6 (ENV-1, head d7f91d5) | `diff -rq --strip-trailing-cr C:/Users/stack/vault/projects/sessiondeck/planning docs/planning`; supporting: `pnpm -F @sessiondeck/scripts test` | diff printed nothing, exit 0. Scripts suite exit 0: `Test Files 29 passed (29)`, `Tests 578 passed \| 4 skipped (582)`. No test compares the vault copy; `scripts/test/scaffold.test.ts` "R0.6 project scaffold files" covers scaffold files only, so the diff is the proof of the vault-identity clause | pass | 2026-10-19 23:15Z |
| Sprint 1 user gate: docs/ENVIRONMENT.md filled (Claude Code version, plan type, Git Bash, WSL2, Node) | `grep -n -i -E "claude code\|plan type\|git bash\|wsl2\|node" docs/ENVIRONMENT.md`; `grep -n "pending user" docs/ENVIRONMENT.md` | Line 7 Claude Code version `2.1.295`; line 8 Plan type `Max (decision 11, user, 2026-10-19)`; line 11 Git Bash `yes, C:\Program Files\Git\usr\bin\bash.exe`; line 12 WSL2 `yes: Claude sessions run in WSL2 ...` (mix of WSL2 and native flagged as the conductor's call, not user-confirmed); line 13 Node `v24.19.0 local`. `grep "pending user"` printed nothing, exit 1 (no matches) | pass | 2026-10-19 23:15Z |

ENV-1 result: 2 pass / 0 fail / 0 unverifiable.

## INFRA-1 (p0/sprint-auth): nested session auth

INFRA-1 verification (2026-10-20, branch p0/sprint-auth, worktree `C:/Users/stack/projects/wt/INFRA-1`, head f3b9390). Fix: Claude Code strips `CLAUDE_CODE_OAUTH_TOKEN` by name from Bash tool subprocesses; `infra/sprint/entrypoint.sh` stage 2 exports `SPRINT_CLAUDE_OAUTH_TOKEN` (same value) and `PROMPT-BOOK.md` section 2 launches level 2 from it. Serves R0.8 (tokens enter only through `.sprint/env`; sprint container path).

| Requirement | Command | Key output | Result | Timestamp (UTC) |
|---|---|---|---|---|
| R0.8 static: mirror | `pnpm -F @sessiondeck/scripts exec vitest run -c vitest.sprint.config.ts test/sprint-image-static.test.ts --reporter=verbose` | `Test Files 1 passed (1)`, `Tests 68 passed (68)`. Mirror tests, all passing: "exports the nested-session token mirror after require_var and before launching claude"; "never prints or writes the token mirror, and the pre-stage does not read it"; "keeps the mirror export top-level and unconditional so a .sprint/env value is always overwritten"; under "PROMPT-BOOK.md section 2 launch command": "sets the OAuth token from the mirror directly before claude -p and reads no stdin" and "keeps the agent, permission flag, stream format and the session log tee". 5 mirror/launch tests of 68 | pass | 2026-10-20 01:00Z |
| R0.8 sprint tooling suite | `pnpm -F @sessiondeck/scripts test:sprint`; `pnpm -F @sessiondeck/scripts typecheck`; `pnpm -F @sessiondeck/scripts lint` | test:sprint: `Test Files 13 passed (13)`, `Tests 284 passed (284)`. typecheck: `tsc --noEmit` no output, exit 0. lint: `eslint .` no output, exit 0 | pass | 2026-10-20 01:00Z |
| R0.8 container harness (evidence file, not re-run: no containers started) | read `C:/Users/stack/projects/sessiondeck/.sprint/0/screens/INFRA-1/u2-container-check.txt` (orchestrator ran `bash infra/sprint/test/check-sprint-image.sh <dir> --i-have-the-go` at d6e8efd, placeholder tokens, exit 0); `git diff --stat d6e8efd..HEAD -- infra/sprint/entrypoint.sh infra/sprint/entrypoint-precheck.sh infra/sprint/test/check-sprint-image.sh`; `git diff d6e8efd..HEAD -- infra/sprint/test/claude-stub.sh`; `grep -c -E "sk-ant\|ghp_\|github_pat_"` on the evidence file | Line 214: `result: 0 failure(s)`. Lines 114 and 199: `PASS  first-run 4 SPRINT_CLAUDE_OAUTH_TOKEN mirror equals CLAUDE_CODE_OAUTH_TOKEN: equal` and `PASS  second-run 4 SPRINT_CLAUDE_OAUTH_TOKEN mirror equals CLAUDE_CODE_OAUTH_TOKEN: equal`. Check 6 hygiene: `docker logs: 0 matches`, `docker logs show the redaction marker: 2 line(s) carry [REDACTED]`, `/state/<id>/logs/*: 0 matches`, `sprint.jsonl: 0 matches`, `sprint.jsonl shows the redaction marker: 1 line(s) carry [REDACTED]`, `~/.gitconfig of the run: 0 matches`, `/work/.git/config: 0 matches`, `docker history --no-trunc: 0 matches`. Diff stat of the three scripts d6e8efd..HEAD: empty. claude-stub.sh diff: one comment hunk only (adds a comment line about the mirror yes/no verdict). Token-shaped grep: 0 matches. Evidence applies to HEAD | pass | 2026-10-20 01:00Z |
| R0.8 redaction by value | read `infra/sprint/entrypoint.sh` lines 268-285 (`redact_stream`) | Line 280: `oauth = ENVIRON["CLAUDE_CODE_OAUTH_TOKEN"]` (line 281 same for `GH_TOKEN`); line 273: `while ((pos = index(line, secret)) > 0)` replaces each occurrence with the marker; line 283 applies both. Match is by value, and the mirror holds the identical value, so it is redacted in sprint.jsonl and docker logs; the harness lines 116 and 119 show the marker in both | pass | 2026-10-20 01:00Z |
| R0.8 real-token nested `claude -p` authenticates (section 2 command from the orchestrator's Bash tool) | none runnable here (placeholder tokens only); proof is the first Sprint 1 relaunch: S1/S3/S5 logs under `.sprint/1/logs/` | Not run. Pass criteria: no "Not logged in" in the logs and status files appear | needs laptop confirmation | 2026-10-20 01:00Z |
| R0.8 deny rules and `guard.mjs` active inside the container | none runnable here; check at the same relaunch by issuing one command the guard blocks and confirming it is refused | Not run | unverifiable (open, check at the Sprint 1 relaunch) | 2026-10-20 01:00Z |

INFRA-1 result: 4 pass / 0 fail / 2 unverifiable (1 needs laptop confirmation, 1 open).

# FIX-5 (R0.5 test budget), HEAD dbb1e33, range 03ddab7..dbb1e33

Verified 2026-10-21T18:45Z by sd-verifier. Host: Debian 12 on WSL2, node v22.23.3, 20 logical CPUs (2-vCPU proxy via `taskset -c 0-1`). Raw outputs: /state/1/gate/FIX-5/verify-*.txt.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R0.5 install and static gates | `pnpm install --frozen-lockfile`; `pnpm -r typecheck`; `pnpm -r lint`; `pnpm lint:root` | install "Lockfile is up to date"; typecheck, lint, lint:root all exit 0 (verify-install.txt, verify-static.txt) | pass | 2026-10-21T18:33Z |
| R0.5 format | `pnpm format:check`, then `git ls-files \| xargs pnpm exec prettier --check --ignore-unknown` | format:check exit 1, but all 174 warnings are under untracked `wt/` (0 outside wt/). Tracked files: "All matched files use Prettier code style!" (verify-format-tracked.txt) | pass (tracked files; wt/ untracked, not ours) | 2026-10-21T18:34Z |
| R0.5 full suite, all CPUs | `pnpm -r test` | exit 0, wall 17 s. contract 1090 pass/1 skip (28 files); hub 282 (21 files); probe 311 pass/1 skip (11); web 214 (20); scripts 575 pass/7 skip (28 files, 1 skipped) (verify-test-full.txt) | pass | 2026-10-21T18:35Z |
| R0.5 full suite, 2-vCPU proxy | `taskset -c 0-1 pnpm -r test` | exit 0, wall 41 s (budget 60 s). Same counts as above (verify-test-2cpu.txt). Host load average was 4.96 at start (other sessions), so this is a pessimistic proxy | pass (local) | 2026-10-21T18:36Z |
| R0.5 measurements | read /state/1/gate/FIX-5/f1-2cpu-summary.md, f1-cpu-summary.md | 2-CPU proxy, workspaceConcurrency 2 / sort false: 29.1, 30.8 s; conc 3: 31.7, 31.0; conc 5: 36.6; conc 8: 35.8, 34.6; conc 3 + maxWorkers=1: 42.6, 39.6; topological order conc 2: 32.1, 34.1. All rc=0. Sum of package CPU ~59.5 s, /2 vCPU ~30 s, matches wall. Per-package pool/maxWorkers/coverage-include tuning (threads, forks, maxWorkers 1/2) found no meaningful CPU savings (web 12.7 to 20.3 s, scripts 9.7 to 11.9 s regardless; hub threads breaks 1 test; coverage costs ~1 CPU s in contract). The suite is CPU-bound at about 30 s on 2 cores | pass (local evidence) | 2026-10-21 |
| R0.5 CI history | read /state/1/gate/FIX-5/f1-ci-package-durations.txt, /state/1/gate/03-ci.log, 03-ci-head-failed.log | Repo is private: hosted runners have 2 vCPUs. Before the fix, 03-ci.log shows "test (R0.5 budget 60 s)" failing on ubuntu node 22 and 24 (1m21s, 1m34s) and a failure on windows node 22 (2m50s). At 03ddab7 (03-ci-head-failed.log): windows-latest node 22 and node 24 jobs failed (3m28s, 3m02s) on the test step timeout; ubuntu node 22 passed (6m16s), e2e-web-live passed | fail at 03ddab7 (windows-latest step timeout), pending CI for dbb1e33. NOT marked pass | 2026-10-21 |
| R0.5 CI at dbb1e33 | none runnable here (orchestrator pushes after this verification) | not run | pending-CI | 2026-10-21 |

Count: 5 pass (local) / 1 fail (CI at 03ddab7) / 0 unverifiable, 1 pending-CI. R0.5 overall stays open until CI at dbb1e33 is green on windows-latest.

## FIX-5 resume (R0.5 option A), HEAD 45ec370

Verified 2026-10-21T19:28:06Z by sd-verifier. Host: Debian 12 on WSL2, node v22.23.3, 20 logical CPUs (2-vCPU proxy via `taskset -c 0,1`), pwsh absent, load average 2 to 3.5 from other sessions. Decision: R0.5 option A (/state/1/answers/FIX-5.md); phase doc note 2026-10-21 in docs/planning/phases/phase-0-contract.md. Raw outputs: /state/1/gate/FIX-5/verify2-*.txt. No file under packages/web, packages/hub or infra changed since dbb1e33.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R0.5 install | `pnpm install --frozen-lockfile` | "Lockfile is up to date", wall 0.26 s (verify2-install.txt) | pass | 2026-10-21T19:28:06Z |
| R0.5 typecheck | `pnpm -r typecheck` | exit 0, wall 9.5 s (verify2-typecheck.txt) | pass | 2026-10-21T19:28:06Z |
| R0.5 lint | `pnpm -r lint` | exit 0, wall 7.8 s (verify2-lint.txt) | pass | 2026-10-21T19:28:06Z |
| R0.5 step, all CPUs | `pnpm -r test` | exit 0, wall 14.5 s (< 60 s). contract 1090 pass/1 skip (28 files); hub 282 (21); probe 311 pass/1 skip (11); web 214 (20); scripts 324 pass/3 skip (18 files, 1 skipped) (verify2-test-full.txt) | pass (local) | 2026-10-21T19:28:06Z |
| R0.5 step, 2-vCPU proxy | `taskset -c 0,1 pnpm -r test` | exit 0, wall 32.7 s (< 60 s). Same counts, 0 failures (verify2-test-2cpu.txt) | pass (local) | 2026-10-21T19:28:06Z |
| CI step: probe processes | `pnpm -F @sessiondeck/probe test:proc` | exit 0, 146 pass/4 skip (11 files), wall 39.5 s (limit 5 min) (verify2-probe-proc.txt) | pass (local) | 2026-10-21T19:28:06Z |
| CI step: scripts processes | `pnpm -F @sessiondeck/scripts test:proc` | exit 0, 258 pass/4 skip (11 files), wall 4.6 s (limit 5 min) (verify2-scripts-proc.txt) | pass (local) | 2026-10-21T19:28:06Z |
| CI step: guard timing | `pnpm -F @sessiondeck/scripts test:guard-timing:ci` | exit 0, 81 pass (3 files), single attempt, wall 12.5 s (limit 7 min) (verify2-guard-timing.txt) | pass (local) | 2026-10-21T19:28:06Z |
| CI step: sprint tooling | `pnpm -F @sessiondeck/scripts test:sprint` | pwsh is ABSENT in this container: exit 0 but 205 pass/79 skip (3 of 13 files skipped); the skipped rows are the PowerShell ones. In CI the step uses `shell: pwsh` so it cannot silently skip there. Wall 2.9 s (verify2-sprint.txt) | pass (local, pwsh rows not run here) | 2026-10-21T19:28:06Z |
| Every scripts test file runs in exactly one CI step | `pnpm -F @sessiondeck/scripts exec vitest run test/test-split.test.ts test/ci-steps.test.ts` | 2 files, 14 tests pass (6 + 8) (verify2-split-ci-steps.txt) | pass | 2026-10-21T19:28:06Z |
| R0.5 step layout | all rows above | Both `pnpm -r test` runs under 60 s with 0 failures; every split step passes | pass (local, step layout) | 2026-10-21T19:28:06Z |
| R0.5 CI green on both OSes | GitHub Actions at 45ec370 | not runnable: Actions cannot start any job (account billing block) | pending CI (Actions billing block) | 2026-10-21T19:28:06Z |

Correction to f1a-static.txt: the sum of the five step timeout-minutes in .github/workflows/ci.yml (check job) is 21 min (R0.5 1 + probe processes 5 + scripts processes 5 + guard timing 7 + sprint tooling 3). The 31 in f1a-static.txt is the job budget from the ci.yml comment, which also counts setup/install 5 and static gates 5; the job limit is 40 min.

Count: 10 pass (local) / 0 fail / 0 unverifiable, 1 pending CI (Actions billing block). R0.5 CI row stays open until Actions runs.

## FX-T: transcript fixtures (R0.7)

Verified 2026-10-28T16:43:13Z by sd-verifier on p0/transcript-fixtures, HEAD 8bb136c. Requirement R0.7 (transcript extension), consumer: docs/handoffs/S07-normalizer-and-redaction.md. Host: Windows 11, Git Bash. Counts and key names only; no raw or fixture content printed.

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R0.7 five fixtures, tracked | `git ls-files packages/contract/fixtures/transcripts \| wc -l`, grouped by fixture | 44 tracked files (expected 44). 5 fixtures: 01-subagents, 02-subagents-compaction, 03-compaction, 04-compaction, 05-subagents; each has session.jsonl and README.md; subagents/agent-<id>.jsonl in 01 (8 files incl. none other), 02 (2), 05 (24). Compaction: 4 rows with isCompactSummary (counted by key) across 02, 03, 04 | pass | 2026-10-28T16:43:13Z |
| R0.7 deterministic | `node scripts/fixture-scrub.mjs --transcripts` twice; `find packages/contract/fixtures/transcripts -type f \| sort \| xargs sha256sum \| sha256sum \| cut -c1-16`; `git status --short packages/contract/fixtures/transcripts` | rc 0 both runs; tree hash be80276627bfd436 after run 1 and after run 2 (expected be80276627bfd436); git status output empty (committed files equal scrub output) | pass | 2026-10-28T16:43:13Z |
| R0.7 leak check | `node scripts/fixture-leak-check.mjs; echo exit=$?` | exit=0; "files scanned: 259"; "transcripts: files=44 rows=14545 raw=yes"; "transcript findings: 0"; "PASS: no leaks found" | pass | 2026-10-28T16:43:13Z |
| R0.7 no raw tracked | `git ls-files packages/contract/fixtures/raw \| wc -l`; `git check-ignore packages/contract/fixtures/raw/deny-words.txt` | 0 tracked; check-ignore prints the path, exit 0 (ignored) | pass | 2026-10-28T16:43:13Z |
| R0.7 long free text | structure rule of scripts/fixture-leak-check.mjs (free-text value over 120 chars needs <TRUNCATED n>), run in the leak check row above | transcript findings: 0; also a node scan of all 22 jsonl files: 14528 rows parsed, 0 parse errors | pass | 2026-10-28T16:43:13Z |
| R0.7 thinking redaction | node scan of every content block with type thinking | 1475 thinking blocks; 0 with thinking other than "<REDACTED-THINKING>"; 1475 signature values are all the literal "<REDACTED-THINKING>" (no live signature) | pass | 2026-10-28T16:43:13Z |
| R0.7 emails | regex scan of all 44 files, excluding the <EMAIL> placeholder | 0 other email addresses | pass | 2026-10-28T16:43:13Z |
| R0.7 absolute user paths | grep for C:\Users, C:/Users, /c/Users, /home/, /Users/, C--Users | 0 for C:\Users, C:/Users, /c/Users, /home/, C--Users. 72 occurrences of the substring "/Users/": every one is a path segment named Users after a placeholder (e.g. <PROJECT_x>/.../Users/) and is followed by <DIR_n>; no home-rooted path and no real user name. The leak check private-path rule reports 0. Orchestrator should confirm this reading | pass (with note: 72 "/Users/" segments, placeholder-only) | 2026-10-28T16:43:13Z |
| R0.7 IANA zones | regex scan for Region/City names (America, Europe, Asia, Africa, Australia, Pacific, Atlantic, Indian) | 0 | pass | 2026-10-28T16:43:13Z |
| R0.7 structural fields | node scan, 22 jsonl files | rows 14528; uuid 8610; parentUuid key 8610; sessionId 14449; timestamp 10497; message.id 3068; tool_use blocks 2822; tool_result blocks 2037; tool_result tool_use_id with a matching tool_use id in the same file: 2037 of 2037; resolving within the same fixture (session plus subagents): 2037 of 2037 | pass | 2026-10-28T16:43:13Z |
| R0.7 scripts default suite | `npx vitest run` in scripts/ | 28 files passed; 535 passed, 2 skipped (537) | pass | 2026-10-28T16:43:13Z |
| R0.7 scripts test:proc | `pnpm run test:proc` in scripts/ | 12 files passed; 273 passed, 2 skipped (275) | pass | 2026-10-28T16:43:13Z |
| R0.7 contract tests | `pnpm -F @sessiondeck/contract test` | 28 files passed; 1091 passed | pass | 2026-10-28T16:43:13Z |
| R0.7 typecheck / lint / root lint / format | `pnpm -r typecheck`; `pnpm -r lint`; `pnpm lint:root`; `pnpm format:check` | rc 0, rc 0, rc 0, rc 0 ("All matched files use Prettier code style!") | pass | 2026-10-28T16:43:13Z |
| R0.7 transcript test coverage | scripts/test/transcript-{gate-fixes,inventory,leak,private,review-fixes,round2,round3,round4,scrub,scrub-account}.test.ts (10 files) | By test name: deterministic output (transcript-scrub "is deterministic, keeps row counts and order, and writes the README"; transcript-scrub-account "scrubbing the same rows twice ... byte-identical"); truncation (<TRUNCATED matched in transcript-scrub, -leak, -private, -round2, -round4); thinking removal (transcript-scrub "replaces thinking and signature, keeps the block type", plus leak checker cases); path replacement ("maps path-valued fields: cwd to <HOME> form and other roots to <ROOT>", plus private-path cases in -private, -round2/3/4); email replacement ("replaces emails, userEmail, organizationUuid and request ids"; -scrub-account email forms); unknown key fails closed ("fails closed on an unknown key: key placeholder, value never passes through, reported"). All pass in the suites above | pass | 2026-10-28T16:43:13Z |
| R0.7 fixtures README | grep headings of packages/contract/fixtures/README.md | "## Transcripts" (line 150) with "### Sources", "### Why these five" (selection reasons), "### Scrub rules", "### Regenerate and check", "### Row-type coverage" (tables for row type, system subtype, attachment type, content block, tool_result shape, flag, tool used, slash command); Claude Code version keyword present (8 version-like matches) | pass | 2026-10-28T16:43:13Z |
| R0.7 reviews (cited, not rerun) | read docs/sessions/p0-transcript-fixtures.md | Line 70: sd-reviewer on 5e2b433..0cf61fa verdict merge, 4 MINOR, fixed in 70f6249. Security gate: round 2 pass (line 65), round 3 on 80689a0 pass (line 73), round 4 on d7a22f8 pass (line 75); fixtures committed in 9fd1c34 after the gate (line 76) | pass (cited) | 2026-10-28T16:43:13Z |

Count: 18 pass / 0 fail / 0 unverifiable. Note: the 01-subagents subagent file count is 8 (grep shows 8 entries under subagents/).
