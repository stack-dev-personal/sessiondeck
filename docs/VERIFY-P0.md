# VERIFY-P0: Phase 0 contract, requirements R0.1 to R0.8

- Branch: `p0/scaffold`, HEAD `16ff3478dbe3ff5f85adaf4a1153acd5bac2cb10` (16ff347), clean tree apart from this file
- Date (UTC): 2026-10-09, runs 05:48Z to 05:52Z
- Machine: Windows 11 Home 10.0.26200 (Git Bash, MINGW64), Node v24.19.0, pnpm 12.10.1; CI runs Node 22 and 24 on ubuntu-latest and windows-latest
- Verifier: sd-verifier. Every row below comes from a command run at 16ff347 in this pass.

## Scope of this pass

S0 builds the contract, reducer, capture tooling and scaffold. The user's capture day and the fixture session S0b come after S0 by plan (`docs/planning/04-session-map.md` section 2, `docs/handoffs/S00b-fixtures-and-reducer-finalization.md`). Clauses that need captured real-session fixtures (R0.1 fixture walk, R0.2 golden timeline, R0.4 captured statusLine parse, R0.7 fixture count and scrub review) therefore wait for S0b and are marked `pending S0b`. They exist as skipped tests that un-skip themselves (or fail loudly) once fixtures exist. R0.8 belongs to S0c. All other clauses are proven now, on synthetic payloads where stated. Result values: `pass`, `fail`, `pending S0b`, `out of scope (S0c)`.

## Results

| Requirement | Clause | Command | Key output | Result | Timestamp |
|---|---|---|---|---|---|
| R0.1 | rejects missing v, id, host, kind, ts, seq | `pnpm -F @sessiondeck/contract test` (`packages/contract/test/envelope.test.ts:21` `it.each([v,id,host,kind,ts,seq])("rejects a missing %s")`) | envelope.test.ts 23 tests, 1 skipped, rest pass; contract 238 passed / 13 skipped / 0 failed | pass | 05:49Z |
| R0.1 | validates every captured fixture when wrapped | same; skipped test `packages/contract/test/envelope.test.ts:108` (`describe.skipIf(fixtures.length === 0)` at :111); `git ls-files packages/contract/fixtures` lists only settings/ | no captured fixtures in repo, walk not exercised | pending S0b | 05:49Z |
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
| R0.4 | parses captured statusLine fixtures | same; skipped tests `statusline.test.ts:182` and `describe.skipIf(statusFixtures.length === 0)` at :187 | skipped, no captured samples yet | pending S0b | 05:49Z |
| R0.5 | CI green on both OSes | `gh run list --branch p0/scaffold --limit 3`; `gh run view 37890035505 --json conclusion,headSha,jobs` | run 37890035505 is for headSha 16ff347, conclusion success; all four jobs success: ubuntu-latest node 22, ubuntu-latest node 24, windows-latest node 22, windows-latest node 24 | pass | 05:49Z |
| R0.5 | `pnpm -r test` under 60 s | `time pnpm -r test` (twice) | wall 8.9 s and 8.9 s (contract 12 files, scripts 17 files); CI test step "test (R0.5 budget 60 s)": ubuntu/22 10 s, ubuntu/24 12 s, windows/24 31 s, windows/22 35 s | pass | 05:49Z |
| R0.6 | `docs/planning/` matches the vault copy | `diff -rq --strip-trailing-cr C:/Users/stack/vault/projects/sessiondeck/planning docs/planning` | no output, exit 0 (content equal; checkout is CRLF) | pass | 05:49Z |
| R0.6 | `.claude/agents/` contains the nine sd-* agents | `ls .claude/agents/sd-*.md` | 12 files: all nine named agents present (orchestrator, executor-contract/probe/hub/web/infra, reviewer, security-reviewer, verifier) plus conductor, researcher, sprint-orchestrator | pass | 05:49Z |
| R0.6 | scaffold test | `pnpm -F @sessiondeck/scripts test` (`scripts/test/scaffold.test.ts`, "R0.6 project scaffold files") | scaffold.test.ts 23 tests pass | pass | 05:49Z |
| R0.7 | capture tooling exists and works: 17 hook events plus statusLine registered in exec form, existing hooks preserved, hook silent and exit 0, payload written under raw/<event>/, uninstall restores | harness (step 9, transcript below) plus `pnpm -F @sessiondeck/scripts test` | install exit 0; 17 events registered; Stop group shows `"command":"node"` with `args`, the fixture's own `stop-notify.sh` group preserved; hook exit 0, 0 stdout bytes, 0 stderr bytes; file under `raw/Stop/`; uninstall exit 0; `restored equals original: true`; scripts suite 17 files, 227 passed / 3 skipped / 0 failed | pass | 05:50Z |
| R0.7 | raw captures cannot be committed by accident | `git ls-files packages/contract/fixtures`; `git check-ignore -v packages/contract/fixtures/raw/x` | tracked: only `fixtures/settings/README.md` and `with-harness-hooks.json`; ignored by `.gitignore:45:packages/contract/fixtures/raw/` | pass | 05:49Z |
| R0.7 | at least 50 raw fixtures across at least 12 hook events plus 20 statusLine samples committed, scrubbed, reviewed by sd-security-reviewer | `git ls-files packages/contract/fixtures` | 0 captured fixtures committed; needs the user's capture day | pending S0b | 05:49Z |
| R0.8 | run-sprint smoke, renderer tests, tokens only via `.sprint/env` | not run | belongs to S0c | out of scope (S0c) | n/a |

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

Requirement table: 25 rows, 20 pass / 0 fail / 4 pending S0b / 1 out of scope (S0c). Definition of done: 2 more pass (coverage, CONTRACT.md); the two sign-off rows read "see session log" and are not counted.

Overall: 22 pass / 0 fail / 4 pending S0b / 1 out of scope
