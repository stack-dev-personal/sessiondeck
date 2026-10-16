# VERIFY-P0: Phase 0 contract, requirements R0.1 to R0.8

- Branch: `p0/scaffold`, HEAD `16ff3478dbe3ff5f85adaf4a1153acd5bac2cb10` (16ff347), clean tree apart from this file
- Date (UTC): 2026-10-09, runs 05:48Z to 05:52Z
- Machine: Windows 11 Home 10.0.26200 (Git Bash, MINGW64), Node v24.19.0, pnpm 12.10.1; CI runs Node 22 and 24 on ubuntu-latest and windows-latest
- Verifier: sd-verifier. Every row below comes from a command run at 16ff347 in this pass.

## Scope of this pass

S0 builds the contract, reducer, capture tooling and scaffold. The user's capture day and the fixture session S0b come after S0 by plan (`docs/planning/04-session-map.md` section 2, `docs/handoffs/S00b-fixtures-and-reducer-finalization.md`). Clauses that need captured real-session fixtures (R0.1 fixture walk, R0.2 golden timeline, R0.4 captured statusLine parse, R0.7 fixture count and scrub review) therefore wait for S0b and are marked `pending S0b`. They exist as skipped tests that un-skip themselves (or fail loudly) once fixtures exist. R0.8 belongs to S0c. All other clauses are proven now, on synthetic payloads where stated. Result values: `pass`, `fail`, `pending S0b`, `out of scope (S0c)`. S0c (sprint tooling) adds the result `needs laptop confirmation (live tokens)` and its own section at the end of this file.

## Results

| Requirement | Clause | Command | Key output | Result | Timestamp |
|---|---|---|---|---|---|
| R0.1 | rejects missing v, id, host, kind, ts, seq | `pnpm -F @sessiondeck/contract test` (`packages/contract/test/envelope.test.ts:21` `it.each([v,id,host,kind,ts,seq])("rejects a missing %s")`) | envelope.test.ts 23 tests, 1 skipped, rest pass; contract 238 passed / 13 skipped / 0 failed | pass | 05:49Z |
| R0.1 | validates every captured fixture when wrapped | `git worktree add --detach <tmp> 9839118`, node_modules linked, then `npx vitest run test/envelope-walk.test.ts test/envelope.test.ts test/statusline.test.ts --reporter=verbose` in packages/contract (`envelope-walk.test.ts`) | 3 files, 578 passed, 0 failed, 0 skipped. Walked: hooks 176 files over 13 events (176 parse tests), statusLine 20, subagentStatusLine 5, golden session 295 lines, synthetic 5 (reported separately, not captured). Each category also has a not-empty guard and a wrapped-fixture test that removing v, id, host, kind, ts or seq is rejected. envelope.test.ts: 22 passed incl. 7 missing-field rejections | pass | 04:17Z |
| R0.2 | reduce() is pure and total | same (`packages/contract/test/state.test.ts:190` "R0.2 purity and totality": every state x event x payload gives a valid fresh snapshot; `:182` input not mutated) | state.test.ts 69 tests, 7 skipped, rest pass | pass | 05:49Z |
| R0.2 | real-session fixture sequence produces the expected timeline | same; skipped test `packages/contract/test/state.test.ts:524` "golden timeline from a real session's fixtures" (`expect.fail` TODO) | skipped; only a synthetic timeline test at :458 runs | pending S0b | 05:49Z |
| R0.3 | PermissionRequest gives waiting_permission | same (`state.test.ts:22` "PermissionRequest moves to waiting_permission") | pass | pass | 05:49Z |
| R0.3 | Notification permission_prompt while already waiting is a no-op | same (`state.test.ts:28`) | pass | pass | 05:49Z |
| R0.3 | Stop after AskUserQuestion gives waiting_input | same (`state.test.ts:65` "PreToolUse(AskUserQuestion) then Stop gives waiting_input") | pass | pass | 05:49Z |
| R0.3 | StopFailure gives error | same (`state.test.ts:101` "StopFailure gives error and records the error type") | pass | pass | 05:49Z |
| R0.3 | SessionEnd gives ended with reason | same (`state.test.ts:108` "SessionEnd gives ended with ended_reason taken from reason") | pass | pass | 05:49Z |
| R0.3 | liveness dead gives exited | same (`state.test.ts:118` "liveness alive:false gives exited") | pass | pass | 05:49Z |
| R0.3 | same-pid new session_id marks previous ended | same (`state.test.ts:152` "supersedeSamePid ends the previous session on the same host and pid as superseded") | pass | pass | 05:49Z |
| R0.4 | parses a sample with rate_limits (synthetic) | same (`packages/contract/test/statusline.test.ts:28`) | pass; payloads are synthetic (session_id "synthetic-session") | pass | 05:49Z |
| R0.4 | parses a sample without rate_limits (synthetic) | same (`statusline.test.ts:41`) | pass | pass | 05:49Z |
| R0.4 | parses current_usage null (synthetic) | same (`statusline.test.ts:46`) | pass | pass | 05:49Z |
| R0.4 | #52326 leak: percentage carrying the resets_at epoch becomes null (synthetic) | same (`statusline.test.ts:131` "nulls the #52326 leak"; `:143` out-of-range and non-finite) | pass | pass | 05:49Z |
| R0.4 | parses captured statusLine fixtures; with and without rate_limits, current_usage null, #52326 leak | `git worktree add --detach <tmp> 9839118`, node_modules linked, then `npx vitest run test/envelope-walk.test.ts test/envelope.test.ts test/statusline.test.ts --reporter=verbose` in packages/contract (`statusline.test.ts`) | 44 passed, 0 skipped. All 20 statusLine and 5 subagentStatusLine samples parse; captured five_hour and seven_day windows normalize; captured current_usage-null sample (06-usage-null) parses. Leak case is DERIVED from a captured sample (capture has no leak, its max is 96): percentage above 100 becomes null | pass | 04:17Z |
| R0.5 | CI green on both OSes | `gh run list --branch p0/scaffold --limit 3`; `gh run view 37890035505 --json conclusion,headSha,jobs` | run 37890035505 is for headSha 16ff347, conclusion success; all four jobs success: ubuntu-latest node 22, ubuntu-latest node 24, windows-latest node 22, windows-latest node 24 | pass | 05:49Z |
| R0.5 | `pnpm -r test` under 60 s | `time pnpm -r test` (twice) | wall 8.9 s and 8.9 s (contract 12 files, scripts 17 files); CI test step "test (R0.5 budget 60 s)": ubuntu/22 10 s, ubuntu/24 12 s, windows/24 31 s, windows/22 35 s | pass | 05:49Z |
| R0.6 | `docs/planning/` matches the vault copy | `diff -rq --strip-trailing-cr C:/Users/stack/vault/projects/sessiondeck/planning docs/planning` | no output, exit 0 (content equal; checkout is CRLF) | pass | 05:49Z |
| R0.6 | `.claude/agents/` contains the nine sd-* agents | `ls .claude/agents/sd-*.md` | 12 files: all nine named agents present (orchestrator, executor-contract/probe/hub/web/infra, reviewer, security-reviewer, verifier) plus conductor, researcher, sprint-orchestrator | pass | 05:49Z |
| R0.6 | scaffold test | `pnpm -F @sessiondeck/scripts test` (`scripts/test/scaffold.test.ts`, "R0.6 project scaffold files") | scaffold.test.ts 23 tests pass | pass | 05:49Z |
| R0.7 | capture tooling exists and works: 17 hook events plus statusLine registered in exec form, existing hooks preserved, hook silent and exit 0, payload written under raw/<event>/, uninstall restores | harness (step 9, transcript below) plus `pnpm -F @sessiondeck/scripts test` | install exit 0; 17 events registered; Stop group shows `"command":"node"` with `args`, the fixture's own `stop-notify.sh` group preserved; hook exit 0, 0 stdout bytes, 0 stderr bytes; file under `raw/Stop/`; uninstall exit 0; `restored equals original: true`; scripts suite 17 files, 227 passed / 3 skipped / 0 failed | pass | 05:50Z |
| R0.7 | raw captures cannot be committed by accident | `git ls-files packages/contract/fixtures`; `git check-ignore -v packages/contract/fixtures/raw/x` | tracked: only `fixtures/settings/README.md` and `with-harness-hooks.json`; ignored by `.gitignore:45:packages/contract/fixtures/raw/` | pass | 05:49Z |
| R0.7 | at least 50 raw fixtures across at least 12 hook events plus 20 statusLine samples committed, scrubbed, reviewed by sd-security-reviewer | `git ls-files packages/contract/fixtures` (counts per dir); `git ls-files ... \| grep -c /raw/`; `pnpm -F @sessiondeck/contract test`; `pnpm -F @sessiondeck/scripts run fixture:leak`; `grep -l '"rate_limits"'` over tracked statusLine; `docs/sessions/p0-fixtures.md` U1 | at bdcbaca: 176 captured hook fixtures across 13 events (PreToolUse 62, PostToolUse 84, PostToolUseFailure 6, PermissionRequest 4, Notification 3, SessionStart 3, SessionEnd 3, Stop 3, SubagentStop 3, UserPromptSubmit 2, PreCompact 1, PostCompact 1, SubagentStart 1); 20 statusLine samples, 17 with `rate_limits`; 5 subagentStatusLine; tracked paths under `raw/`: 0, `.gitignore:45:packages/contract/fixtures/raw/` ignores it; synthetic (not counted toward captured totals, conductor decision 7): 5 files for TaskCreated, TaskCompleted, PermissionDenied, StopFailure; contract suite 23 files, 664 passed / 9 skipped / 0 failed, `fixtures-counts.test.ts` 7 passed; leak gate `files scanned: 210`, `PASS: no leaks found`; sd-security-reviewer "Gate: pass" at 3899726 (before the fixture commit), a6984c2 and 2c61aa2; iteration 3 at f9775be pending in the log's line 49, superseded by the round-3 pass at 2c61aa2 | pass | 03:37Z |
| R0.8 | `run-sprint.ps1 -Sprint smoke` produces `.sprint/smoke/status.json` with state green within two minutes on Docker Desktop for Windows | live: not run (no tokens on this machine by design). Proven now: harness `bash infra/sprint/test/check-sprint-image.sh` with the stub `claude` (see S0c section, E2); `powershell.exe scripts/sprint/smoke-check.ps1` with placeholder tokens (E5) | Harness: first and second run each show "status.json visible on host with state green", exit 0. Placeholder run: container started as uid=1000, tokens present (values never logged), `RESULT: FAIL` at the clone step (exit 128, expected), start 1.8 s, `stop-sprint` exit 0, no container left. Not proven: real auth, real clone, a real session writing green within 120 s | needs laptop confirmation (live tokens) | 22:08Z |
| R0.8 | the renderer has a test per package block in `MINI-SPRINT-ORDER.md` | `pnpm -F @sessiondeck/scripts test:sprint` (renderer files: `pnpm exec vitest run -c vitest.sprint.config.ts test/sprint-render` in `scripts/`); `scripts/test/sprint-render.test.ts:26` ("one test per package block"), `:27` finds exactly sprints 0 to 5, `:31` one yaml fence per tested block, `:37` `it.each(packages)` | 7 files, 126 passed / 0 failed (verified by CI in the sprint tooling step); CLI re-run at 33bde60 exits 0 for 0, 1 to 5 (`--contract-sha 0123abc`) and smoke; renders sprint 0 (54 lines), 1 (61), 2 (54), 3 (55), 4 (58), 5 (56) and smoke (1) with exit 0; `--sprint 9` exits 2 with the valid ids. No `{NAME}` placeholder left except the two documented pass-throughs `{SESSION_ID}` and `{SESSION_BRANCH}` and the literal `${CLAUDE_PROJECT_DIR}` text inside package 0 | pass | 23:15Z |
| R0.8 | tokens enter only through `.sprint/env` | static tests + harness check 6 + repo grep (S0c section, E6) | `git check-ignore -v .sprint/env` hits `.gitignore:18 .sprint/`; compose has `env_file: ${SPRINT_ENV_FILE:-../../.sprint/env}` and no interpolated token; Dockerfile has no token ARG/ENV (`sprint-image-static.test.ts:490`); `run-sprint.ps1` only `Test-Path`s the file (line 131) and has no `Get-Content`/hash/copy anywhere in `scripts/sprint`; harness check 6: 0 matches in docker logs, state logs, `sprint.jsonl`, `~/.gitconfig`, `/work/.git/config`, `docker history --no-trunc`; no token-shaped value in tracked files | pass | 22:07Z |
| R0.8 handoff | `infra/sprint/Dockerfile` | `infra/sprint/test/check-sprint-image.sh` build + checks 5, 9; `sprint-image-static.test.ts` (63 tests) | image `sessiondeck-sprint:local` id bfb55e2edf3e built from it; non-root uid 1000 (harness 2); root refused with the documented message, non-root exits 1 with an auth error (check 5); shellcheck clean (check 9); no token in `docker history` | pass | 21:38Z |
| R0.8 handoff | `infra/sprint/docker-compose.yml` | harness check 1 (compose v5.6.0 present) and 3 (socket reaches host daemon: server 29.8.1; sibling container ran and was removed); `sprint-image-static.test.ts:554,558,575` | env_file only, no interpolated token, code-loading names pinned empty; run of the compose service reaches the pre-stage and the entrypoint | pass | 21:38Z |
| R0.8 handoff | `infra/sprint/entrypoint.sh` (and `entrypoint-precheck.sh`) | harness checks 4, 6, 7, 8, 10; `sprint-image-static.test.ts` entrypoint and pre-stage blocks | 34 guard checks (check 7) refuse unlisted or hostile variables with exit 64 naming the variable; BASH_ENV marker never ran; clone path once, fetch path on second run (8); SIGTERM forwarded, exit 143 within 1 s of 15 s (10); entrypoint never echoes a token value (`:114`) | pass | 21:38Z |
| R0.8 handoff | `scripts/sprint/run-sprint.ps1` with `-Sprint` and `-Resume` | `pnpm -F @sessiondeck/scripts test:sprint` (`sprint-ps-run.test.ts`, 32 tests, 32 passed at 33bde60; `-Resume` appears on 11 lines of the test file); `run-sprint.ps1:51` param, `:230-232` resume needs an existing state dir | 279 passed / 0 failed in the sprint tooling suite (13 files, 44 s locally; verified by CI: sprint step green on both windows jobs in both runs, 76 to 112 s); remote docker target refused exit 3, planted links refused exit 4 | pass | 23:15Z |
| R0.8 handoff | `scripts/sprint/status.ps1` | same command, now `test:sprint` (`sprint-ps-stop-status.test.ts`, 27 tests with stop) | pass in the 279 (verified by CI); output reduced to printable ASCII, link rows shown as `link refused` | pass | 23:15Z |
| R0.8 handoff | `scripts/sprint/stop-sprint.ps1` | same command; placeholder smoke run (E5) and harness check 10 | `stop-sprint: ran, exit 0` after the smoke run; "stopped sprint-smoke; kept volume sprint-smoke-work and the state directory"; `docker ps -a --filter name=sd-0-S0c --filter name=sprint-smoke` empty afterwards | pass | 22:08Z |
| R0.8 handoff | `scripts/sprint/render-prompt.mjs` with unit tests against every package block | see the second R0.8 row; 7 renderer test files | 126 passed (verified by CI) / 0 failed; 6 package blocks plus smoke render | pass | 23:15Z |
| R0.8 handoff | `.sprint/` state layout and the atomic-write helper `packages/contract/src/state-file.ts` | `pnpm -r test` (contract), re-run at 33bde60: 9 `state-file-*.test.ts` files (index, secrets, layout, status, lock, atomic, merge, cli-merge, cli) | contract 22 files, 434 passed / 13 skipped (433 on ubuntu CI) (the 13 are the S0 `pending S0b` skips) / 0 failed; `state-file.ts` 100 % lines and branches; `state-file-cli.ts` 96.33 % lines (uncovered 158-161); no per-file threshold failed (run exit 0; verified by CI on both OSes) | pass | 23:12Z |
| R0.8 handoff | smoke package (`-Sprint smoke`) | `node scripts/sprint/render-prompt.mjs --sprint smoke`; harness; `smoke-check.ps1` | renders exactly one line (`write /state/smoke/status.json with state green and exit`), runs through the container end to end with the stub (green) and with placeholders (to the clone). The real-token green run is the first R0.8 row, not this one | pass (package and harness); live run needs laptop confirmation (live tokens) | 22:08Z |
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

Contract skips: 13, all `TODO(fixture)` or provisional placeholders (`envelope.test.ts:108`, `statusline.test.ts:182`, `state-permission.test.ts:101`, `state-review2.test.ts:78`, `state.test.ts:419,425,431,437,443,449,524`, plus the two `describe.skipIf(...length === 0)` blocks that hold the captured-fixture walks). Scripts skips: 3, platform or environment skips (symlink privilege, POSIX-only block on Windows).

## Definition of done

| Item | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| 100% line coverage on `packages/contract/src/state.ts` and `envelope.ts` | `pnpm -F @sessiondeck/contract test` (vitest `--coverage`, v8) | `envelope.ts \| 100 \| 100 \| 100 \| 100`; `state.ts \| 100 \| 100 \| 100 \| 100`; All files 100 lines. Per-file `lines: 100` thresholds in `packages/contract/vitest.config.ts` cover envelope.ts, state.ts and the nine files the reducer is built from (the run exits 0, so thresholds held). `grep -rnE "istanbul ignore\|c8 ignore\|v8 ignore"` over packages and scripts: no matches. Note: `transcript.ts` shows 0 across the row (no executable lines) and has no threshold | pass | 05:49Z |
| `docs/CONTRACT.md` exists and its diagram is generated from the transition table | `pnpm -F @sessiondeck/contract gen:doc -- --check`; drift test `packages/contract/test/docs.test.ts:47` ("generated block '%s' is up to date") | `docs/CONTRACT.md is up to date.`; docs.test.ts passes | pass | 05:49Z |
| sd-reviewer has signed off | see session log (`docs/sessions/p0-scaffold.md`), recorded by the orchestrator | not marked by the verifier | see session log | n/a |
| sd-security-reviewer has signed off the fixtures | see session log (`docs/sessions/p0-scaffold.md`), recorded by the orchestrator | not marked by the verifier; no fixtures exist yet | see session log | n/a |
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

Requirement table: 37 rows (24 from S0 plus 13 from S0c, which replace the old R0.8 row), 32 pass / 0 fail / 4 pending S0b / 1 needs laptop confirmation (live tokens). Definition of done: 3 more pass (coverage, CONTRACT.md, sprint-tooling security sign-off as recorded); the sd-reviewer and fixtures sign-off rows read "see session log" and are not counted. S0c rows were brought up to date at 33bde60 (counts and commands only; no result value changed). The S0c evidence is in the section below.

Overall: 35 pass / 0 fail / 4 pending S0b / 1 needs laptop confirmation (live tokens)

## S0c: sprint tooling (R0.8 and the sprint-tooling sign-off)

- Branch `p0/sprint-tooling`, HEAD 33bde60 (updated pass; earlier passes verified 842e199 and 61811a7). Since 61811a7: a6e9510 (batched spawns in the S0c tests; ENOTDIR treated as nothing to remove), a2ac93d and 0966704 (sprint tooling tests moved to `test:sprint` and their own CI step; drift guard `test-split.test.ts`; README testing section), 0d2ef5b and 33bde60 (root `ci` script runs `test:sprint`; PowerShell harness throws on CI when no PowerShell starts; shell batch timeout tested). Code under `scripts/sprint`, `infra/sprint` and `packages/contract/src` changed only in the `discardTemp` ENOTDIR handling. Base `sprint/0-bootstrap` at 3702f2c, no rebase needed. Date (UTC) 2026-10-14, local runs about 23:10Z to 23:20Z.
- Machine: Windows 11 Home 10.0.26200, AMD Ryzen AI 9 465, 31,898 MB RAM, Node v24.19.0, pnpm 12.10.1, Docker server 29.8.1, Compose v5.6.0. Commands run one at a time, no background processes.
- Verifier: sd-verifier. Result value added in this pass: `needs laptop confirmation (live tokens)` (the clause needs real `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`, which this machine does not hold by design; what is proven now is stated in the row; it is neither pass nor fail).

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

Note on "verified by CI": the S0c rows verified by local runs (R0.8 renderer, state-file helper, handoff rows for the PowerShell scripts) are also backed by CI at 33bde60: push and pull_request runs both green on all four jobs. The container rows (Dockerfile, compose, entrypoint, stop) and the placeholder smoke run are not CI-covered (CI has no image build). The R0.5 S0 row (run 37890035505 at 16ff347) is unchanged. The live smoke row stays "needs laptop confirmation (live tokens)".

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

- Real-token smoke (green within 120 s): laptop only. README `:118` states this too.
- Deferred review findings (not fails): LOW bare-name shell fallback on Windows (hardening for later); MINOR `scripts/test/fixtures/sprint-ps/harness.ts:52` probe error code; MINOR `discardTemp` wording; LOW token-start rule in `state-file-secrets.ts:40`.
- Not observed: a rejected or expired token's message; `--agent` with `-p` and a project-scoped agent (README `:129-131`).
- GitHub token scope details are marked in the README as unchecked against GitHub's page.
- User decision on the docker socket (accept, proxy, ECI or rootless DinD) is open; README `:50` says it must be made before writing `.sprint/env`.
