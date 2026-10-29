# Verification, Phase 1 (probe)

Branch p1/probe-hook, HEAD c311225. Verified 2026-10-20 (Linux WSL2 container, node v22.23.3). Session S1 rows below; S2 adds R1.4-R1.7.

CI for c311225: run 39359243907, conclusion success. Jobs: windows-latest node 22 success, windows-latest node 24 success, ubuntu-latest node 22 success, ubuntu-latest node 24 success. Each ran the step `test probe processes (R1.2 R1.3 R1.8 R1.9 R1.10, outside R0.5)` with success.

Workspace gates (all exit 0): `pnpm -r typecheck`, `pnpm -r lint`, `pnpm lint:root`, `pnpm format:check`.
`pnpm -r test` (fast suites, wall 11.7 s, R0.5 budget 60 s): scripts 575 passed / 7 skipped (28 files); contract 1090 passed / 1 skipped (28 files); probe 70 passed (4 files).
`pnpm -F @sessiondeck/probe test:proc`: 5 files, 137 passed, 2 skipped (Windows-only: ICACL SID check, win-utf8), 8.5 s.

| Session | ID | Command | Key output | Result | Timestamp |
|---|---|---|---|---|---|
| S1 | R1.1 hook p95 < 80 ms | `pnpm -F @sessiondeck/probe build`; `node packages/probe/scripts/bench-hook.mjs` x3 | p95 42.6 / 35.9 / 41.3 ms (p50 29.8-33.6); bare `node -e 0` p95 25-31 ms. See docs/PROBE-BENCH.md | PASS on container; authoritative number is the Windows laptop bench (needs_laptop, A15), not yet run | 2026-10-20T02:32Z |
| S1 | R1.2 never non-zero, never stdout | `pnpm -F @sessiondeck/probe test:proc` | tests "R1.2 hook never fails and never prints" (empty, closed, not json, array, null, number, invalid utf-8, missing session_id, 1 MB, all fixtures, never-closing stdin 2048 ms, unwritable spool, --home is a file); "R1.2 session and event ids are bounded". All green | PASS; verified by CI (win + ubuntu, step above) | 2026-10-20T02:31Z |
| S1 | R1.3 50 parallel hooks, 0 corrupted | same; `test/stress.proc.test.ts` | "R1.3 spool under 50 parallel hooks" rounds 1, 2, 3: "exact count, every line parses as SpoolLine, unique ids, 0 corrupted lines" (390-424 ms each). Test prints no counts; the assertions are the evidence | PASS; verified by CI | 2026-10-20T02:31Z |
| S1 | R1.8 install keeps harness hooks, idempotent | same; `test/install.proc.test.ts` | "leaves every pre-existing group, matcher, statusLine, permissions and env untouched"; "is idempotent: a second and third run leave a byte-identical file and no new backup"; "uninstall restores a 2-space file byte for byte"; "malformed settings are refused". Fixture with-harness-hooks.json is loaded through packages/probe/test/fixtures/sandbox.ts | PASS; verified by CI | 2026-10-20T02:31Z |
| S1 | R1.9 statusLine one-liner, never throws | same; `test/statusline.proc.test.ts` | "R1.9 statusline fixtures" 12-first-tick ... 20-first-tick, 5h n/a cases; "robustness (both entries)" empty/closed/malformed/array/invalid utf-8/1 MB all exit 0 with fallback line. 20 of 20 statusLine fixture tests present and green | PASS; verified by CI | 2026-10-20T02:31Z |
| S1 | R1.10 config outside settings, 0600/0700, token not leaked | same; `test/config.proc.test.ts`, `install.proc.test.ts` | "writes probe.json outside the settings directory; the token is nowhere else"; "probe.json is 0600 and the probe home is 0700 on POSIX"; "rejects the token as an argument, without echoing it"; "config show masks the token"; "never leaves the token in the registered hook args". Windows ICACL test skipped on Linux, ran on windows CI step (success) | PASS; Windows part verified by CI | 2026-10-20T02:31Z |
| S2 | R1.4 cursor survives restart, 0 dup ids, 0 gaps in seq; exactly one of 8 simultaneous starters wins | `pnpm -F @sessiondeck/probe test:proc --maxWorkers=2` (7 files); `pnpm exec vitest run -c vitest.proc.config.ts --maxWorkers=1 lock-race` x5 sequential; `node scripts/build.mjs && node scripts/harness-loss.mjs` (packages/probe). Re-verify at HEAD 08ad4cb after lock fix b799eb2, 7fd9b0a | test:proc: 7 files passed, 142 passed / 2 skipped. lock-race.proc 5 of 5 isolated runs 3/3 pass (stale lock, no lock: exactly one winner over 20 rounds each; live lock: no winner). Harness: `R1.4 kill/restart: sent=500 accepted=500 duplicates=0 gaps=0 order=ok daemon_kills=3 resent_ids=83 requests=7`. Windows (taskkill, NTFS) not run here: verified by CI (pending) | PASS (Linux). Windows aspects: verified by CI | 2026-10-20T16:14Z-16:17Z |
| S2 | R1.5 hub down 10 min, all delivered in order per host | `SD_OUTAGE_MS=600000 timeout 900 node scripts/harness-loss.mjs` (packages/probe), full 10 minute outage, 16:17:20Z to 16:27:26Z | `R1.5 outage 600000ms: sent=500 accepted=500 duplicates=0 gaps=0 order=ok delivered_during_outage=0 recover_ms=609` then `RESULT pass`, exit 0. Same run: `R1.4 kill/restart: sent=500 accepted=500 duplicates=0 gaps=0 order=ok daemon_kills=3 resent_ids=123 requests=10` | PASS | 2026-10-20T16:27Z |
| S2 | R1.6 transcript tailer: each line once (incl. restarts), compaction, rotation, subagent after SubagentStart | `pnpm -F @sessiondeck/probe exec vitest run test/transcript.test.ts --maxWorkers=2`; `node packages/probe/scripts/harness-transcript.mjs`. HEAD ec73388, component only (not yet wired into daemon, U4; end-to-end re-verified at session close) | Vitest: 1 file, 37 passed / 1 skipped (win32 real-fs). Once: "delivers each line once...", "each line once across restarts (graceful and mid-file)", "a crash after the outbox write replays with identical start_line", "a failed outbox write commits nothing". Compaction: "compaction rewrite (file shrinks) resets the offset and keeps counting", "truncate to zero then regrow resets". Rotation: "atomic replace by a LARGER file is a reset" and "in-place rewrite to the same length is caught by the head fingerprint" (both strategies), "windows heuristic with an injected stat: birthtime change resets, ctime alone does not", shouldReset table (D-S2-8). Subagent: "tails subagent transcripts after SubagentStart, not before", "a subagent file that does not exist yet is picked up when it appears", "SubagentStop without a tracked SubagentStart delivers via agent_transcript_path", "SessionEnd does a final drain...". Harness: `R1.6 lines_written=209 delivered=209 duplicates=0 resets=2 subagent_lines=50 restarts=3`; `order_main=ok order_subagent=ok start_line_contiguous=true stopped_after_session_end=true`; `RESULT pass`, exit 0. Windows real-fs test ("windows real filesystem") skipped on Linux: verified by CI (windows-latest) | PASS (Linux). Windows aspect: verified by CI | 2026-10-20T16:45Z |
| S2 | R1.7 pid dies without SessionEnd -> liveness envelope within 15 s (pid liveness every 10 s, ~/.claude/sessions second opinion) | `pnpm vitest run test/liveness.test.ts --maxWorkers=2`; `pnpm exec vitest run -c vitest.proc.config.ts --maxWorkers=1 test/liveness.proc.test.ts`; `node scripts/build.mjs && node scripts/harness-liveness.mjs` (packages/probe). HEAD fac07f5, code 6de4041 | Unit: 63 passed. Proc: `R1.7 real process > detects a killed pid and queues alive:false within 15 s` passed (1 of 1, 21.6 s). Harness: `R1.7 killed_pid=108947 detected_ms=11484 envelope=alive:false within_15s=true`; `payload_pid_matches=true`; `sessionend_suppressed=true same_pid_old_session_silent=true same_pid_new_session_reported=true`; `no_duplicate_after_restart=true`; `RESULT pass`. Code read: src/daemon/liveness.ts `TICK_MS = 10_000`, `GRACE_MS = 1_500` (10 s + 1.5 s under 15 s), imports SessionsReader/sessionsDir from sessions-file.ts (reads ~/.claude/sessions, honours CLAUDE_CONFIG_DIR). Windows-only (Win32 process snapshot, pid reuse via process start time) not run here: verified by CI (windows-latest), needs laptop confirmation | PASS (Linux). Windows parts: verified by CI, needs laptop confirmation | 2026-10-20T17:49Z |

S2 unit check (U1, daemon core, HEAD f563f93, Linux WSL2, node v22.23.3), packages/probe: `pnpm test` 7 files, 130 passed; `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test:proc` first run 140 passed / 2 skipped, second run 1 failed (lock-race), isolated lock-race reruns 0 of 3 passed. Windows-specific behaviour (taskkill path, NTFS) is verified by CI (pending) in windows-latest.

Count (all ten IDs, R1.1-R1.10, as of the FIX-2 re-confirmation below): 10 pass / 0 fail / 0 unverifiable. Windows-only parts are verified by CI; laptop-native R1.1 number and the Windows retry path remain laptop-only extras, not counted as failures.

## Re-confirmation on sprint/1-mvp merge (FIX-1, 2026-10-21)

Tree: sprint/1-mvp at 0e321fe plus staged uncommitted `git merge --no-ff --no-commit p1/probe-hook`. Linux WSL2 container, node v22.23.3. One test process at a time, `--maxWorkers=2`. Windows-only checks are not runnable here and stay "verified by CI" (run 39359243907 at c311225, recorded above; CI on the merged tree not yet run).

| ID | Command | Result | Evidence |
|---|---|---|---|
| R1.1 | `pnpm -F @sessiondeck/probe build`; `node packages/probe/scripts/bench-hook.mjs` | pass on container: 200 runs, 0 bad, p50 33.6 ms, p95 43.1 ms (< 80). Laptop number still outstanding (needs laptop) | /state/1/gate/FIX-1/verify-bench-hook.txt |
| R1.2 | `pnpm -F @sessiondeck/probe test:proc` (hook-robust.proc.test.ts) | pass (5 files, 137 passed, 2 skipped Windows-only) | /state/1/gate/FIX-1/verify-probe-proc.txt |
| R1.3 | same (stress.proc.test.ts rounds 1 to 3) | pass | same |
| R1.8 | same (install.proc.test.ts, 42 tests) | pass | same |
| R1.9 | same (statusline.proc.test.ts, 45 tests, 1 skipped) | pass | same |
| R1.10 | same (config.proc.test.ts, 11 tests, 1 skipped = Windows ICACL) | pass on POSIX; Windows ICACL/win-utf8 part: verified by CI | same |
| Gates | `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` | pass (exit 0; probe unit 70, contract 1090, hub 282, scripts 575) | /state/1/gate/FIX-1/{typecheck,lint,test}.txt |

Count: 6 pass / 0 fail; verified by CI only: Windows part of R1.10 and the 2 skipped Windows-only tests; needs laptop: R1.1 authoritative number.


## S2 U4a integration check (daemon wiring, `probe daemon run`)

Branch p1/probe-daemon, HEAD a7a7e93. Verified 2026-10-20T19:22Z to 19:30Z (Linux WSL2 container, node v22.23.3). One test process at a time, --maxWorkers=2 or fewer.

| ID | Command | Key output | Result |
|---|---|---|---|
| all | `pnpm -F @sessiondeck/probe exec vitest run --maxWorkers=2` | 10 files passed; 261 passed, 1 skipped (262), 8.4 s | PASS |
| all | `pnpm exec vitest run -c vitest.proc.config.ts --maxWorkers=2` (packages/probe, `test:proc`) | 10 files passed; 145 passed, 2 skipped (Windows-only), 57 s; includes `daemon-run.proc.test.ts`: "probe daemon run (R1.4) starts, heartbeats to the hub, and exits 0 on SIGTERM" | PASS |
| R1.4 | `node packages/probe/scripts/harness-daemon-e2e.mjs` | "seq contiguous, no duplicate ids: 12 envelopes, seq 0..11, conflicts=0, resent_ids=0"; "no redelivery after daemon kill and restart: non_heartbeat_before=9 after=9 resent_ids=0 conflicts=0"; whole run 63 envelopes, seq 0..62, conflicts=0 | PASS |
| R1.5 | same harness; component 10 min run in U2 rows above | Hub-down 10 min is NOT re-run through `daemon run`; the e2e harness covers in-order delivery with seq 1,4,5 and restart only. Integrated 10-minute outage has no runnable check in the repo | FAIL (integration unverifiable; component PASS above) |
| R1.6 | `node packages/probe/scripts/harness-transcript.mjs`; e2e harness | "R1.6 lines_written=209 delivered=209 duplicates=0 resets=2 subagent_lines=50 restarts=3", order ok, RESULT pass; e2e: main 9/9 and subagent 7/7 exactly once through the daemon, resumes tailing after restart 10/10 | PASS |
| R1.7 | e2e harness | "liveness alive:false within 15 s of the kill: detected_ms=11795 pid=166528" (limit 15000) | PASS |
| D-S2-11 | read `packages/probe/src/daemon/transcript.ts`; `vitest run test/transcript.test.ts -t "backslash exploit\|drive-letter"` | `trusted()` first calls `foreignStyle(p, platform)` (`platform !== "win32" && (includes("\\") \|\| /^[A-Za-z]:/)`), logs a warn and returns undefined. Tests "backslash exploit: a link named a\b under projects pointing outside is refused" and "a drive-letter path is refused on a posix platform" exist (posix only) and pass (2 passed) | PASS |

Windows-only paths (win32 real-filesystem tests, junction cases, win32 CI matrix): CI pending. HEAD a7a7e93 run 39482860743 in_progress; 763ec25 run 39482661180 cancelled (superseded); earlier run 39480584779 (e7b6660) failed (the transcript test the 763ec25 fix addresses). Not verified by CI yet.

U4a count: 5 pass / 1 fail / 0 unverifiable (R1.5 integration gap; Windows CI pending).

## S2 U4b integration check (autostart R1.4, daemon-process outage R1.5)

Branch p1/probe-daemon, HEAD 7c1f9a7. Verified 2026-10-20T22:21Z to 22:25Z (Linux WSL2, node v22.23.3). One test process at a time, --maxWorkers=2.

| ID | Requirement | Command | Key output | Result |
|---|---|---|---|---|
| R1.4 | `probe daemon install/uninstall` registers the daemon at logon (Windows per-user Task Scheduler, Limited, InteractiveToken, files under %LOCALAPPDATA%\sessiondeck, D-S2-7; Linux systemd user unit) | `pnpm exec vitest run --maxWorkers=2` (packages/probe, unit, includes test/autostart.test.ts with fake runner) | 11 files passed; 305 passed, 1 skipped (306), 7.2 s; `test/autostart.test.ts (44 tests)` green | PASS |
| R1.4 | Linux systemd unit, real files | `pnpm exec vitest run -c vitest.proc.config.ts --maxWorkers=2 test/autostart.proc.test.ts --reporter=verbose` | `systemd user unit (real files, no user bus) > writes the unit, prints how to start it, exits 0; uninstall removes it` passed (144 ms); 1 passed, 2 skipped | PASS (Linux) |
| R1.4 | Windows real Task Scheduler and real wscript launcher restart | same file: `windows Task Scheduler (real) > registers a logon task for the current user, Limited, and removes it`; `windows launcher restart (real wscript) > restarts a daemon that exits non-zero and stops when it exits 0` | Both skipped on Linux. Last real windows-latest result: run 39486100922 on 4eb9e97, only the RunLevel assertion failed; fixed in 9b1ccc7. No run on 9b1ccc7 or 7c1f9a7 exists because GitHub Actions has no runner assigned since 22:15Z | verified by CI (pending: Actions unavailable) |
| R1.4 | docs/PROBE.md daemon section matches behavior | read docs/PROBE.md lines 104-175 against the autostart tests | Section exists: task name SessionDeckProbeDaemon, logon trigger, Limited, no admin, files under %LOCALAPPDATA%\sessiondeck, launcher restart backoff, /End then taskkill of the node pid, Linux unit with Restart=on-failure. Matches the test names; not re-checked against a real Windows host | PASS (read check) |
| R1.5 | All events delivered in order across an outage, through a real `probe daemon run` process | `node scripts/build.mjs` then `node scripts/harness-daemon-outage.mjs` (packages/probe), compressed default SD_OUTAGE_MS=15000 | `R1.5 daemon outage 15000ms via probe daemon run: sent=600 accepted=600 duplicates=0 gaps=0 order=outage-host=ok delivered_during_outage=0 resent_ids=0 recover_ms=501`, `RESULT pass`, exit 0 | PASS (compressed, 15 s) |
| R1.5 | Full 10 minute outage through the daemon process | `SD_OUTAGE_MS=600000 SD_BACKOFF_CAP_MS=30000 node scripts/harness-daemon-outage.mjs` (about 11 min, exceeds the 10 min shell call limit) | NOT RUN. Deferred to the session-close verify. The 10 minute component-level run passed at 0143d8e (see R1.5 row above) | NOT VERIFIED at 600000 ms through the daemon process |
| gates | typecheck, lint (packages/probe) | `pnpm typecheck`; `pnpm lint` | both exit 0 | PASS |

U4b count: 4 pass / 0 fail / 2 unverifiable-now (Windows scheduler and launcher: CI pending; 10 min daemon-process outage: deferred).

## S2 session-close verification (R1.4-R1.7, final evidence)

Branch p1/probe-daemon, code HEAD 830239d (docs commit follows). Verified 2026-10-20T22:43Z to 22:51Z (Linux WSL2, node v22.23.3). One test process at a time, --maxWorkers=2. This section supersedes the S2 rows and U4a/U4b sections above where they differ.

Gates: `pnpm -r typecheck` exit 0; `pnpm -r lint` exit 0; `pnpm format:check` exit 0. `pnpm -r --workspace-concurrency=1 test -- --maxWorkers=2` exit 0: contract 1090 passed / 1 skipped; hub 177 passed (15 files); probe 305 passed / 1 skipped (11 files); scripts 575 passed / 7 skipped. `pnpm -F @sessiondeck/probe test:proc -- --maxWorkers=2` exit 0: 11 files, 146 passed / 4 skipped (Windows-only), 37.6 s.

| ID | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R1.4 | `node scripts/harness-loss.mjs`; `harness-daemon-e2e.mjs`; `test:proc` (lock-race, daemon-e2e, autostart systemd) | `R1.4 kill/restart: sent=500 accepted=500 duplicates=0 gaps=0 order=ok daemon_kills=3 resent_ids=52`; e2e `seq 0..62, conflicts=0, resent_ids=0`, no redelivery after restart; lock-race 3/3 (exactly one winner of 8, 20 rounds); systemd unit proc test passed | PASS (Linux). Windows Task Scheduler and launcher: verified by CI (pending: Actions unavailable) | 2026-10-20T22:47Z |
| R1.5 | `harness-loss.mjs`; `harness-daemon-outage.mjs` (compressed 15 s); `harness-integration-hub.mjs` | loss: `R1.5 outage 15000ms: sent=500 accepted=500 duplicates=0 gaps=0 order=ok recover_ms=655`; daemon: `sent=600 accepted=600 duplicates=0 gaps=0 order=outage-host=ok resent_ids=0 recover_ms=906`; real hub container killed and restarted: `sent=500 accepted=500 duplicates=0 gaps=0` RESULT pass. Full SD_OUTAGE_MS=600000 run NOT re-run here (exceeds the foreground limit); cited from 0143d8e: `sent=500 accepted=500 duplicates=0 gaps=0 order=ok recover_ms=609` | PASS (10 min at component level from 0143d8e; daemon process compressed only, 10 min through the daemon process not run) | 2026-10-20T22:48Z |
| R1.6 | `harness-transcript.mjs`; `harness-daemon-e2e.mjs` | `lines_written=209 delivered=209 duplicates=0 resets=2 subagent_lines=50 restarts=3`, order ok, start_line_contiguous=true; e2e main 9/9, subagent 7/7 once, resumes 10/10 after restart, outside-projects path refused | PASS (Linux). Windows real-fs replace: verified by CI (pending: Actions unavailable) | 2026-10-20T22:46Z |
| R1.7 | `harness-liveness.mjs`; `harness-daemon-e2e.mjs`; `test:proc` liveness | `killed_pid=42207 detected_ms=11553 envelope=alive:false within_15s=true`; e2e `detected_ms=11772`; sessionend_suppressed, same_pid_old_session_silent, no_duplicate_after_restart all true | PASS (Linux). Windows paths: verified by CI (pending: Actions unavailable) | 2026-10-20T22:48Z |

Note (R1.7, accepted degraded mode, D-S2-13): when the first Windows process snapshot fails, tracking starts up to about 26 s after SessionStart (about 70 s if all 6 retries are used) and a death inside that window sends no envelope; after tracking, death is caught within 11.5 s via `kill(pid, 0)`. The retry helps only when the reported pid is claude itself (exec-form hook). Details in docs/PROBE.md, "Liveness: known gaps".

Integration (`node packages/probe/scripts/harness-integration-hub.mjs`): docker build ok in 19 s, hub healthy, `accepted_before_kill=165`, hub log `accepted=501 duplicates=0`, `sent=500 accepted=500 duplicates=0 gaps=0`, RESULT pass, exit 0. The diagnostic line `seq_gaps=1` (heartbeat seq 0 vs 500 events) did not fail the check; final `gaps=0`. `docker ps -a --filter name=sd-1-S2` empty afterwards.

CI: `gh run list --branch p1/probe-daemon -L 3` on 2026-10-20T22:50Z: 39510297500 (830239d, 5 s), 39507270068 (4 s), 39506713349 (6 s) all `failure` in seconds with no runner (Actions unavailable since 22:15Z). Last real windows-latest run with all probe tests passing: 39482860743 (19:22Z); 39486100922 on 4eb9e97 failed only the RunLevel assertion fixed in 9b1ccc7.

Final count (R1.4-R1.7): 4 pass (Linux) / 0 fail / Windows parts verified by CI (pending).

## S2 final verification (R1.4-R1.7, after CI robustness and R1.7 retry changes)

Branch p1/probe-daemon, HEAD 4753a69 (this docs commit follows). Local re-run 2026-10-20T23:36Z to 23:42Z (Linux WSL2, node v22.23.3), one test process at a time, foreground, --maxWorkers=2. Supersedes the "S2 session-close verification" section where they differ (that section was at code 830239d, before a7ff744, 057a3d8, 552b53f test-only changes and the R1.7 source changes 127e7e6, 410ad80).

Local results:

| Check | Command | Key output | Result |
|---|---|---|---|
| Probe unit suite | `pnpm -F @sessiondeck/probe test -- --maxWorkers=2` | 11 files passed, 311 passed / 1 skipped (312), 3.47 s | PASS |
| Probe process suite | `pnpm -F @sessiondeck/probe test:proc -- --maxWorkers=2` | 11 files passed, 146 passed / 4 skipped (Windows-only), 37.5 s | PASS |
| R1.7 liveness harness | `node packages/probe/scripts/harness-liveness.mjs` | `killed_pid=105434 detected_ms=11460 envelope=alive:false within_15s=true`, sessionend_suppressed, same_pid_old_session_silent, no_duplicate_after_restart all true, `RESULT pass` | PASS |
| Daemon e2e harness | `node packages/probe/scripts/harness-daemon-e2e.mjs` | 11 PASS lines: seq 0..62 conflicts=0 resent_ids=0; transcript main 9/9 and subagent 7/7 once; outside-projects path refused; `detected_ms=11796`; no redelivery after restart; `RESULT pass` | PASS |
| Typecheck, lint, format | `pnpm -F @sessiondeck/probe typecheck`; `... lint`; `pnpm format:check` | all exit 0; "All matched files use Prettier code style!" | PASS |

Windows CI evidence: run 39514897145 on 4753a69, jobs check (windows-latest, node 22) 118944841232, check (windows-latest, node 24) 118944840857, check (ubuntu-latest, node 22/24) 118944841300 and 118944841182, all `success`. Logs read with `gh run view --job <id> --log`. The probe process suite ran in the "test probe processes (outside R0.5)" step on both Windows jobs (Windows lines below are node 22; node 24 shows the same tests passing).

| Windows-only item | Test and pass line (windows-latest, node 22) | Status |
|---|---|---|
| Real Task Scheduler registration (R1.4) | `autostart.proc.test.ts (3 tests \| 1 skipped)`; `windows Task Scheduler (real) > registers a logon task for the current user, Limited, and removes it  9229ms` (node 24: 3333 ms) | verified by CI (run 39514897145) |
| Launcher restart (R1.4) | `windows launcher restart (real wscript) > restarts a daemon that exits non-zero and stops when it exits 0  1355ms` (node 24: 1069 ms) | verified by CI (run 39514897145) |
| Lock race (R1.4) | `lock-race.proc.test.ts (3 tests) 60731ms`: stale lock, no lock: exactly one winner of 8 over 20 rounds; live lock: no winner (node 24: 3 tests, 47987 ms) | verified by CI (run 39514897145) |
| Transcript Windows real-fs replace (R1.6) | `transcript.test.ts (58 tests \| 3 skipped)` passed in the unit step on both Windows jobs. The `windows real filesystem > replace-by-rename with a larger file resets under the default strategy` test is `describe.skipIf(platform !== "win32")`; it is skipped on Linux (1 skipped locally) and the Windows skip count of 3 is the posix-only tests, so it ran. The log is non-verbose and prints no per-test line for it | verified by CI (run 39514897145), by file-level pass and skip accounting, not by a named line |
| Liveness real process (R1.7) | `liveness.proc.test.ts (1 test) 21542ms`: `R1.7 real process > detects a killed pid and queues alive:false within 15 s`. Printed line: `R1.7 proc: tracking after 0 ms (first snapshot succeeded)` (identical on node 24). The retry tick was NOT needed in this run | verified by CI (run 39514897145) for the first-snapshot-succeeds path |

Skipped on Windows too: none of the five items above. Not exercised by any run: the retry-tick path on a real Windows host (the snapshot never failed in CI, so the 127e7e6/410ad80 retry is covered only by unit tests with an injected failing table), and the 10 minute daemon-process outage.

Final status per requirement:

| ID | Evidence | Result |
|---|---|---|
| R1.4 | Local: unit, proc (lock-race 3/3, daemon-loss 500 envelopes 0 duplicates 0 gaps across 3 daemon kills), e2e harness. Windows: Task Scheduler, launcher restart, lock race in run 39514897145 | PASS (Linux); Windows verified by CI (run 39514897145) |
| R1.5 | Local: daemon-loss.proc outage test and e2e; compressed outage and real hub container from the prior section remain valid (no R1.5 source change since). Full 10 min through the daemon process still not run | PASS at component level (10 min cited from 0143d8e); daemon-process outage compressed only |
| R1.6 | Local: unit 58 transcript tests, e2e main 9/9, subagent 7/7 once, resume after restart. Windows real-fs replace in run 39514897145 | PASS (Linux); Windows verified by CI (run 39514897145) |
| R1.7 | Local: liveness harness `detected_ms=11460`, e2e `detected_ms=11796`, liveness.proc pass. Windows: liveness.proc real process pass in run 39514897145 | PASS with accepted degraded mode D-S2-13 (unreadable first Windows snapshot: tracking starts about 26 s late, up to about 70 s, and a death in that window sends no envelope; see docs/PROBE.md "Liveness: known gaps") |

Needs laptop confirmation: the 10 minute outage through the real daemon process; Windows behaviour when the process table is unreadable (retry path, D-S2-13), which CI did not trigger. Everything else Windows-specific is verified by CI.

Final count (R1.4-R1.7): 4 pass / 0 fail / 0 unverifiable (R1.5 10 minute daemon-process outage and R1.7 retry path on a real Windows host remain laptop-only extras, not counted as failures).

## Re-confirmation on sprint/1-mvp merge of p1/probe-daemon (FIX-2, 2026-10-21)

Tree: sprint/1-mvp at 3d6167c plus staged uncommitted `git merge --no-ff p1/probe-daemon`. Linux WSL2 container, node v22.23.3. One test process at a time, `--maxWorkers=2`. Windows-only parts are not runnable here and stay "verified by CI".

| ID | Command | Result | Evidence |
|---|---|---|---|
| R1.1 | `pnpm -F @sessiondeck/probe build`; `node packages/probe/scripts/bench-hook.mjs` | pass on container: 200 runs, 0 bad, p50 31.3 ms, p95 38.9 ms (< 80). Laptop-native number: needs laptop | /state/1/gate/FIX-2/verify-bench-hook.txt |
| R1.2 | `pnpm -F @sessiondeck/probe test:proc --maxWorkers=2` (hook-robust.proc.test.ts) | pass (11 files, 146 passed, 4 skipped, all Windows-only or no-systemd-bus guarded) | /state/1/gate/FIX-2/verify-probe-proc.txt |
| R1.3 | same (stress.proc.test.ts, 50 parallel hooks) | pass | same |
| R1.4 | same (lock-race.proc 3/3, daemon-loss.proc 500 envelopes); `node scripts/build.mjs && node scripts/harness-loss.mjs` | pass: sent 500 accepted 500 duplicates 0 gaps 0 order ok, 3 daemon kills | /state/1/gate/FIX-2/verify-probe-proc.txt, verify-loss-quick.txt |
| R1.5 | `SD_OUTAGE_MS=600000 timeout 900 node scripts/harness-loss.mjs` (full 10 minute outage) | pass: outage 600000 ms, sent 500 accepted 500 duplicates 0 gaps 0 order ok, delivered_during_outage 0, recover 252 ms | /state/1/gate/FIX-2/verify-loss-full.txt |
| R1.6 | `node scripts/harness-transcript.mjs` | pass: 209 written, 209 delivered, 0 duplicates, order ok (main and subagent), 3 restarts, stopped after session end. Windows real-fs replace: verified by CI | /state/1/gate/FIX-2/verify-transcript.txt |
| R1.7 | `node scripts/harness-liveness.mjs`; liveness.proc and daemon-e2e.proc in test:proc | pass: killed pid detected in 11548 ms (< 15 s), alive:false, no duplicate after restart. Windows retry path: verified by CI / needs laptop | /state/1/gate/FIX-2/verify-liveness.txt, verify-probe-proc.txt |
| R1.8 | test:proc (install.proc.test.ts) | pass | /state/1/gate/FIX-2/verify-probe-proc.txt |
| R1.9 | test:proc (statusline.proc.test.ts) | pass (1 Windows-only skipped: verified by CI) | same |
| R1.10 | test:proc (config.proc.test.ts) | pass on POSIX; Windows ICACL part: verified by CI | same |
| Gates | frozen lockfile, typecheck, lint, `pnpm -r test` (reused) | pass (exit 0; contract 1090, hub 282, probe 311, scripts 575) | /state/1/gate/FIX-2/{frozen-lockfile,typecheck,lint,test}.txt |

Count: 10 pass / 0 fail / 0 unverifiable (Windows-only parts verified by CI; R1.1 laptop number outstanding).

# FIX-3 re-confirmation (merge p3/board-mock)

Verified 2026-10-21T01:59:45Z by sd-verifier. Staged merge of p3/board-mock (S5) into sprint/1-mvp, base 88d9c07. Command: `git diff --cached --quiet 88d9c07 -- packages/hub packages/probe packages/contract`, exit 0 (empty diff: hub, probe and contract are byte-identical to 88d9c07). Full suite on the merged tree: /state/1/gate/FIX-3/test.txt, Test Files 28 passed | 1 skipped, Tests 575 passed | 7 skipped, exit 0. Benches not rerun (diff empty). All existing R1.x rows still PASS: no source they cover changed. Result: PASS (no regression). Evidence for the diff check is the exit code only; it was not saved to a file.

# FIX-4 re-confirmation (merge p3/board-live)

Verified 2026-10-21T02:12:20Z by sd-verifier. Staged merge of p3/board-live (S6) into sprint/1-mvp, base fb803a6. Command: `git diff --cached --quiet fb803a6 -- packages/hub packages/probe packages/contract scripts`, exit 0 (empty diff: S6 changes only packages/web, docs, e2e screenshots and ci.yml). Full suite on the merged tree: /state/1/gate/FIX-4/test.txt, contract 1090, hub 282, probe 311, web 214, scripts 575, exit 0; typecheck and lint exit 0. Benches not rerun (diff empty). All existing R1.x rows still PASS. Result: PASS (no regression). Evidence for the diff check: /state/1/gate/FIX-4/verify-p1p2-diff.txt.

## A15, Bun exe (2026-10-27)

Verified 2026-10-27T17:49Z by sd-verifier. Branch p1/hook-exe, HEAD 5614ffb, native Windows 11 (10.0.26200), node v24.19.0, bun 1.4.4. Rebuilt first with `pnpm -F @sessiondeck/probe build && pnpm -F @sessiondeck/probe build:exe`. All installs ran in temp homes (the suites do this); no real user settings touched; no Docker started by the verifier (Sprint 3 containers ran beside the run, 16-17 up); no WSL2 distro touched. Bench detail: docs/PROBE-BENCH.md, section "R1.1 A15 re-bench on the final exe, 2026-10-27 (verifier)".

| ID | Requirement (quoted) | Command | Key output | Result | Timestamp |
|---|---|---|---|---|---|
| R1.1 | "Hook p95 wall time < 80 ms (A15 fallback if not)." Judged on native Windows at p95 < 100 ms (user decision 2026-10-27, option B) | `node scripts/bench-hook.mjs --target exe` x5 (200 runs each, 0 bad) | exe p95 146.6 / 81.2 / 104.7 / 112.7 / 95.8 ms, p50 67.6-75.8; bun-floor p95 63.8 / 128.4 / 72.8; node p95 176.6. 2 of 5 rounds under 100 ms, 0 of 5 under 80. Earlier rounds 80.5 / 79.6 / 79.9 all under 100. Host: 16-17 containers, CPU 40-90% | FAIL on this loaded host (partial is fail); quiet-laptop bench still owed to the conductor | 2026-10-27T17:49Z |
| R1.2 | "Hook never exits non-zero and never writes stdout, under any input including empty or malformed stdin." | `SD_REQUIRE_EXE=1 pnpm -F @sessiondeck/probe test:proc:exe`; `node packages/probe/scripts/parity-exe.mjs`; `pnpm -F @sessiondeck/probe test:proc` | exe suite: 4 files, 69 passed (hook-exe.proc 29 = 26 R1.2 + 3 R1.3; statusline-exe.proc 34; autoload-exe.proc 5; hook-exe-install.proc 1). R1.2 [exe] cases: empty, closed, not json, array, empty object, null, number, invalid utf-8, missing session_id, 1 MB, 4 MB binary, 13 fixtures, --home a file: all exit 0, empty stdout. parity-exe.mjs: 18 PASS, 0 FAIL (hook, statusline, subagents: valid, empty, malformed). Node bundle test:proc: 13 files, 158 passed, 14 skipped (POSIX-only) | PASS | 2026-10-27T17:49Z |
| R1.3 | "Spool lines are complete JSON under concurrent hooks (stress test: 50 parallel hook processes, 0 corrupted lines)." | same as R1.2 | "R1.3 [exe] spool under 50 parallel hooks" rounds 1, 2, 3: "exact count, every line parses, unique ids, 0 corrupted" (769 / 722 / 770 ms). Node: stress.proc.test.ts 3 passed. The assertions are the evidence; no counts printed | PASS | 2026-10-27T17:49Z |
| R1.8 | "`probe install` leaves existing hooks in `settings.json` untouched (test against a settings fixture containing harness hooks) and is idempotent." | `pnpm -F @sessiondeck/probe test:proc` (install-standin.proc: 9, install-standin-review1.proc: 12) and the exe suite (hook-exe-install.proc: 1) | "upgrades a Node-form install to the exe form; harness hooks (even ones named hook.exe) stay byte-identical"; "is idempotent: a second and third run give an identical settings file, state and one exe dir"; "--runtime node round trip: node, exe, node gives the first settings back and records the runtime"; "uninstall removes the exe-form entries and the exe directory, restoring the fixture"; "install copies the built hook exe and the installed hook exe runs silently". All passed | PASS | 2026-10-27T17:49Z |
| R1.10 | "Config and token live outside `settings.json` with user-only permissions." | same (config.proc.test.ts, install-standin*.proc.test.ts) | "installs the exes under the probe home with matching SHA-256 and no temp files left"; "refuses a non-default shared home for --runtime exe, writes nothing, node form still works"; "buildCtx: a spaced exe path no longer skips; an unsafe home still does, with an accurate message"; "a recorded exeDir outside <home>/bin is never deleted". config.proc on Windows: "probe.json ACL grants only the current user, by SID (icacls)", "writes probe.json outside the settings directory; the token is nowhere else", "never leaves the token in the registered hook args" passed; 3 POSIX 0600/0700 tests skipped on Windows (they ran in the earlier Linux container rows) | PASS | 2026-10-27T17:49Z |
| R1.11 | "WSL2: the Linux build (hook, statusline, daemon) installs inside a WSL2 distro without touching existing hooks there, and its envelopes reach the hub on Windows through a loopback bridge (WSL2 bridge harness: all envelopes accepted). Native Windows behavior unchanged." | `pnpm -F @sessiondeck/probe build:exe`; first 4 bytes of `packages/probe/dist/exe/linux-x64/*` | build:exe built linux-x64/hook 105.5 MB, statusline 106.0 MB, subagents 105.5 MB, bun-floor 104.1 MB; first 4 bytes of all four are `7f 45 4c 46` (ELF). Cross-built, never run here. WSL2-distro install and loopback bridge: not applicable to the current setup (user, 2026-10-27): "they run on windows with subagents being connected to wsl2 containers for development and testing." (A2 note, 00-open-decisions.md). Native Windows unchanged: the exe suite above passes | linux-x64 exe build: PASS (ELF, never executed); WSL2 install and bridge: NOT APPLICABLE | 2026-10-27T17:49Z |

Workspace checks on HEAD 5614ffb: `pnpm -F @sessiondeck/probe test`: 13 files, 320 passed, 11 skipped, 6.6 s. `pnpm -F @sessiondeck/probe typecheck` (`tsc --noEmit`): no output, exit 0. `pnpm -F @sessiondeck/probe lint` (`eslint .`): no output, exit 0.

CI: .github/workflows/ci.yml runs `pnpm -F @sessiondeck/probe test:proc` (line 52) and `pnpm -F @sessiondeck/probe test:proc:exe hook-exe` (line 65). Not yet run on GitHub for this branch; the orchestrator adds CI run ids after push.

Count: 5 pass / 1 fail / 0 unverifiable (R1.1 fails on a loaded host; R1.11 passes for the linux-x64 build, and its WSL2 install and bridge part is not applicable and not counted).

## S8d session close (d61edfd), 2026-10-29T14:44Z

| Item | Command | Result |
|---|---|---|
| S8d: no Phase 1 requirement touched (no packages/probe changes) | `git diff --stat origin/sprint/2-content..HEAD -- packages/probe` | empty output | 
