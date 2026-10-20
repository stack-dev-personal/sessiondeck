# Session log: p1/probe-daemon (S2)

- Date: 2026-10-20
- Handoff: docs/handoffs/S02-probe-daemon.md
- Sprint: 1 (mvp), base branch sprint/1-mvp at 5b76608
- Contract SHA: 256d2604b86ff12cc080df546792cc430b89e5a4 (ancestor of base)
- Requirements: R1.4, R1.5, R1.6, R1.7

## Task list

| # | Unit | Requirements | Executor | Allowed paths | Blocked by |
|---|------|--------------|----------|---------------|------------|
| U1 | daemon core: spool reader with persisted cursor, daemon outbox, seq assignment with pending-batch journal, batching, POST /ingest with backoff + jitter, host heartbeat, stub hub, loss harness | R1.4, R1.5 | sd-executor-probe | packages/probe/** | - |
| U2 | transcript tailer: main + subagent, byte offset, compaction/rotation reset (inode on POSIX; size regression, birthtime change, head fingerprint on Windows, see D-S2-8), persisted offsets, transcript harness | R1.6 | sd-executor-probe | packages/probe/src/daemon/transcript*, packages/probe/test/**, packages/probe/scripts/** | U1 |
| U3 | liveness: pid registry from hook liveness lines, 10 s kill(pid,0), ~/.claude/sessions second opinion, findParentPID/cleanupSamePID port | R1.7 | sd-executor-probe | packages/probe/src/daemon/liveness*, new helpers proc-info.ts and sessions-file.ts under packages/probe/src/daemon/, packages/probe/test/**, packages/probe/scripts/harness-liveness.mjs (boundary widened in the delegation; recorded after review) | U1 |
| U4 | daemon wiring and registration: `probe daemon run/install/uninstall`, Task Scheduler per-user logon task (Windows), systemd user unit (Linux), end-to-end daemon process test, docs/PROBE.md daemon section | R1.4-R1.7 (integration) | sd-executor-probe | packages/probe/**, docs/PROBE.md | U2, U3 |
| U5 | NOTICE attribution lines; CI runs the daemon tests on windows-latest | borrow rules | sd-executor-contract | NOTICE, .github/** | U4 |
| U6 | session close: full suite, loss + transcript harnesses, docs/VERIFY-P1.md rows for R1.4-R1.7, docs/PROBE-BENCH.md loss section | all | sd-verifier | docs/VERIFY-P1.md, docs/PROBE-BENCH.md | U1-U5 |

Security gate: not required for S2 (MINI-SPRINT-ORDER security_gated: false). The orchestrator prompt adds sd-security-reviewer for units that touch ingest or tokens: U1 (bearer token use on POST /ingest) and U4 (scheduled task registration) get it.

## Decisions made

- D-S2-1 Base: p1/probe-hook (S1, green, PR #7) descends from sprint/1-mvp and merges before S2 (merge_order S1, S2). This branch fast-forwards onto origin/p1/probe-hook (d6987d1) and builds against S1's real spool (src/spool.ts, spool-format.ts, spool-writer.ts, paths.ts, config). At finish, `git rebase origin/sprint/1-mvp` drops S1's commits once PR #7 is merged; if not merged, the PR notes the dependency.
- D-S2-2 seq: the hook writes no seq (S1 spool.ts). The daemon assigns seq in read order. To keep zero gaps and zero duplicates across crashes, the daemon writes a pending-batch journal (envelopes with seq assigned, plus the cursors they advance to) atomically before sending, resends it verbatim after restart, and commits cursors only on hub ack.
- D-S2-3 Daemon-originated envelopes (heartbeat kind probe, liveness, transcript) go to a daemon-only outbox file (single writer) rather than the hook spool, because transcript chunks exceed the spool's 64 KB line cap and the outbox has no concurrent writers.
- D-S2-4 Transcript payload follows hub S3 (D-S3-9): `{start_line, lines: string[]}`, agent_id on the envelope for subagent transcripts. start_line is a per-(session, agent) line counter that keeps counting across compaction resets, so the hub's (session_id, agent_id, line_no) key never collides after a rewrite.
- D-S2-5 Request size: hub INGEST_BODY_LIMIT is 1 MiB (S3 route.ts). Batches are capped at 200 envelopes, 250 ms, or ~900 KiB body. A single transcript line too large to fit is replaced by a marker line so numbering stays continuous (open question for S7/user).
- D-S2-6 Research (sd-researcher 2026-10-20): cctop @ 6ec6256 MIT (c) 2025 Dean Langsam, read_new_jsonl_lines; ccmonitor @ 88f7d1a MIT (c) 2026 Martin Wickman (LICENSE confirmed), findParentPID/cleanupSamePID/isShellProcess. ~/.claude/sessions/<pid>.json is undocumented beyond "one small file per running session"; fields per anthropics/claude-code#100824: pid, sessionId, cwd, startedAt, procStart, status (busy/idle/shell/waiting), updatedAt. No fixture exists; built against that shape and listed as open question.
- D-S2-7 Autostart: Windows task registered per-user (`-AtLogOn -User <DOMAIN\user>`, RunLevel Limited, Interactive logon), no admin by design; hidden console via a launcher file inside %LOCALAPPDATA%\sessiondeck. The task itself lives in the Task Scheduler store, which the handoff asks for explicitly. Non-admin registration is unverifiable in CI (runner is admin): needs laptop confirmation. If registration needs admin on the laptop, that is the handoff's stop condition and goes to the user.
- D-S2-8 Windows transcript reset rule: architecture 4.2 and the handoff say ctime+size, but NTFS updates ctime (change time) on every append, so ctime would reset on every write and redeliver lines. The tailer resets on size regression (size < offset), birthtime change, or a mismatch of the first 256 consumed bytes (head fingerprint; also covers NTFS tunneling that keeps birthtime across rename-replace). POSIX uses inode change, size regression, and the same fingerprint. Intent of the architecture rule (detect compaction and rotation) is preserved; this is an implementation refinement, not a change to 00-open-decisions.
- D-S2-9 (user, via conductor 2026-10-20T17:36Z, answer "A"): one more (fourth and last) fix iteration for U3 on the five listed findings only (MAJOR proc-info.ts ancestry() snapshot age; four MINORs), then review, verify R1.7, continue with U4-U6. If a MAJOR remains after it, write a new question instead of iterating again.
- D-S2-10 Transcript containment (U4a security iteration 1): the daemon tails only files whose realpath is under the trusted root `<CLAUDE_CONFIG_DIR or ~/.claude>/projects` as seen by the daemon. SessionStart, SubagentStart-derived and SubagentStop paths are all checked against that root (never against a path taken from the spool). A session started with a different CLAUDE_CONFIG_DIR than the daemon's is refused and logged, not tailed; multi-config-dir support is an open question for a later phase.

## Units

### U1 daemon core (R1.4, R1.5)
- Commits 9466783, 5075a58, 950883e; review round 1 fixes 17cb010, round 2 fixes f563f93; round 3: sd-reviewer merge, sd-security-reviewer gate pass.
- Verify (d31fc8f, docs/VERIFY-P1.md): R1.4 FAIL, because lock-race.proc "exactly one of 8 simultaneous starters wins" failed in 4 of 5 runs (2 or 3 winners), so stale-lock takeover is not exclusive. R1.5 counted as FAIL because only the compressed 15 s outage ran; the full 10 min `SD_OUTAGE_MS=600000` run is due at session close.
- New task U1-fix-lock: the executor began reworking src/daemon/lock.ts into generation-numbered lock files (no remove or rename on takeover) plus three test files. Uncommitted when the run died.

### Restart 2026-10-20 ~14:20Z
- The sprint container restarted and killed the run in the middle of U1-fix-lock (not a session failure). Resumed at 14:21Z. Uncommitted diff: lock.ts (+286/-), daemon-review1.test.ts, daemon-review2.test.ts, lock-race.proc.test.ts. Decision: the generation design is sound in principle (exactly one creator per generation through link EEXIST), so sd-executor-probe finishes it rather than discarding it. Review loop restarts at iteration 1 for the fix.

## Deferred findings
- [MINOR] transcript.ts:485,521-531 (U2): after the 30-day pruned memory expires, a returning key numbers from 0; collides with old hub rows only if the old stream had a compaction reset and the resume is more than about 37 days later. Fix: restart above max_issued for unknown keys whose transcript birthtime predates the daemon's first run.
- [MINOR] transcript.ts:78-84 (U2): isUnder compares path text, not realpath; a symlink under projectsDir pointing outside passes. Fix with realpath when U4 wires projectsDir.
- [MINOR] packages/probe/src/daemon/lock.ts:313-323: the check() ENOENT recreate ignores a live lower generation created after an external delete. Short two-holder window, closed at the next verify(). Fix: fail when scan shows any other live generation.
- [MINOR] lock.ts:403-405: if the re-scan after create throws (EMFILE/EACCES), the starter falls through to holding the lock. Fix: tombstone and continue.
- [LOW] lock.ts:139-142: readRaw races lstat against readFileSync (FIFO/symlink swap by the same user). Fix: open O_NOFOLLOW|O_NONBLOCK, fstat, bounded read.
- [LOW] lock.ts:419-421 and index.ts:88-93 hardenDirs: chmod follows symlinks after lstat. Fix: fchmod on an O_DIRECTORY|O_NOFOLLOW fd.
- [LOW] lock.ts scan: readdir on every verify(), with no cap on directory size. Fix: dedicated lock subdirectory or cached scan.

### U1-fix-lock review (after restart)
- b799eb2 generation-numbered lock (tombstone on release). Iteration 1: sd-reviewer merge (3 MINOR), sd-security-reviewer gate pass (1 MEDIUM, 3 LOW). Fixed all in 7fd9b0a (overflow refusal, re-scan after create, recheck after recreate, READY handshake, lstat-bounded readRaw, ensurePrivateDir).
- Iteration 2 on b799eb2..7fd9b0a: sd-reviewer merge, sd-security-reviewer gate pass. lock-race.proc 10/10 isolated runs, about 17 s per file.

### Freeze and restart 2026-10-20 ~15:11Z
- The Docker Desktop VM ran out of memory and the sprint container froze (conductor: orphaned parallel vitest runs); the user restarted it and the run was killed during U1 verify (not a session failure). Resumed 2026-10-20 after 16:08Z. Tree clean at 04cea5e, no vitest processes left.
- Conductor memory rule adopted for the rest of the session: one foreground test process at a time, --maxWorkers=2 or fewer, check `pgrep -f vitest` before each run, no test fan-out across subagents; stall means write a question, not retry. Consequence: U2 and U3 run one after the other, not in parallel.
- Next: U1 verify (R1.4 lock race, R1.5 full 10 min outage), then U2, U3, U4, U5, U6.
- U1 re-verify 0143d8e: R1.4 PASS (lock-race.proc 5/5 isolated, loss harness 500/500/0 dup/0 gaps), R1.5 PASS (full SD_OUTAGE_MS=600000 run, 500/500, order ok, recover_ms=609). Windows aspects verified by CI (pending). U1 complete.

### U2 transcript tailer (R1.6)
- d77bc2b: transcript.ts, transcript.test.ts (21 pass, 1 win32-gated), harness-transcript.mjs (`lines_written=209 delivered=209 duplicates=0 resets=2 subagent_lines=50`, RESULT pass). Subagent path derived as `<dirname(transcript_path)>/<session_id>/subagents/agent-<id>.jsonl`; matches all three SubagentStop fixtures' agent_transcript_path (reviewer confirmed), so no fixture divergence.
- Review iteration 1: sd-reviewer fix-then-merge (1 MAJOR unhandled rejection in onSpoolLine, 7 MINOR). Finding 8 (record the Windows reset rule) resolved by D-S2-8. Findings 1-7 sent to sd-executor-probe.
- f230f09 fixes iteration-1 findings 1-7. Iteration 2: sd-reviewer fix-then-merge (1 MAJOR: pruned set grows forever; 7 MINOR, 1 LOW). Iteration 3 (last) sent with a persisted max-issued counter design.
- For U4: pass `projectsDir` (Claude projects dir) to TranscriptTailer; the untracked SubagentStop fallback depends on it.
- 26a1e25 fixes iteration-2 findings (max_issued counter, bounded pruned map, lost_until window, outbox multi-file fsync, isUnder table tests). Iteration 3: sd-reviewer merge, 2 MINOR deferred. 172 probe tests pass, 1 win32-gated.
- U2 verify 1394e96: R1.6 PASS (component; Windows real-fs replace verified by CI). U2 complete.

### U3 liveness (R1.7)
- 05ff594: liveness.ts, proc-info.ts, sessions-file.ts, liveness tests (22 unit + 1 real-process proc test), harness-liveness.mjs (`detected_ms=10546 within_15s=true`, RESULT pass).
- Review iteration 1: sd-reviewer fix-then-merge (BLOCKING boundary not recorded, resolved by updating the task table above; 2 MAJOR sessions-file fallback picks dead pid, no pid-reuse/reboot check on Windows/macOS; 3 MINOR; 3 LOW). sd-security-reviewer gate pass (2 MEDIUM sessions-dir FIFO/symlink blocking read, unbounded spool registrations and lookups; 3 LOW). Hub follow-up (not this branch): contract reduceLiveness does not call supersedeSamePid, so the hub must call it on every alive:true; reported to the sprint as an open item for S3/S4. statePath LOW goes to U4.
- e9dcb9e fixes iteration-1 findings A-K. Iteration 2: sd-security-reviewer gate pass (5 LOW); sd-reviewer fix-then-merge (2 MAJOR: fileFresh skips start re-check on Windows/macOS; boot-time shift marks live sessions dead after clock step or WSL2 resume; 4 MINOR). Iteration 3 (last) sent.
- a384869 fixes iteration-2 findings 1-6 and security LOWs 7-11. Iteration 3 (final): sd-security-reviewer gate pass (4 LOW); sd-reviewer fix-then-merge with 1 MAJOR: proc-info.ts:391-401 ancestry() reuses a Windows snapshot up to 2 s old without checking it is newer than the hook line, so a reused pid can be resolved to the old process and adopted (false alive:false for a live session, or a wrong supersede). Fix proposed: pass the envelope ts into ancestry() and refetch when cache.at < ts. 4 MINOR (SessionEnd queued behind slow work loses grace window; failed snapshot counted as a completed re-check; work continuing after the 3 s stop(); recheck flag stuck on entries without proc_start).
- Review loop limit (3 iterations) reached with a MAJOR open. Session stopped blocked; question in /state/1/questions/S2.md. U3 not verified; U4, U5, U6 not started.
- Deferred LOWs from U3 security iteration 3: eviction ranking uses attacker-controllable name and sessions file (same-user DoS only); info/warn lines without rate limit (eviction, not confirmed, younger than hook, probation death); SessionEnd and discovery tasks unbounded on the run chain.
- Hub follow-up for S3/S4 (not this branch): contract reduceLiveness does not call supersedeSamePid; the hub must call it on every alive:true.

### Resume 2026-10-20 after 17:36Z
- Answer A recorded as D-S2-9. U3 iteration 4 (final) sent to sd-executor-probe with the five findings verbatim.
- 6de4041 fixes iteration-3 findings 1-5 (ancestry notBefore refetch, pendingEnd for queued SessionEnd, failed snapshot not a re-check, abandoned flag after stop() cap, recheck cleared without proc_start). 235 probe tests pass, 1 skipped; harness RESULT pass (11465 ms).
- Iteration 4 (final, D-S2-9): sd-reviewer merge (2 MINOR), sd-security-reviewer gate pass (2 LOW). Deferred below.
- Deferred from U3 iteration 4:
  - [MINOR] proc-info.ts:399-403: after a forced (stale) read, an empty result for an exited pid triggers a second read on the same rate-limit token. Fix: skip the second read when the first was forced.
  - [MINOR/LOW] liveness.ts:245-253,282: start() never resets `abandoned` (and stop() does not clear pendingEnd); a restarted instance after an abandoned stop would go silent. Not reachable today (daemon stops components only at exit). Fix: reset abandoned and pendingEnd in start(). Candidate for U4 if U4 touches the lifecycle.
- U3 verify 74cddca: R1.7 PASS (63 unit tests, real-process proc test, harness detected_ms=11484 within_15s=true; Windows snapshot and pid-reuse paths verified by CI, needs laptop confirmation). U3 complete.

### U4a daemon wiring (R1.4-R1.7 integration)
- 42f23c9, e827a54, ae27720: TranscriptTailer + LivenessMonitor wired (state under <home>/daemon/), `probe daemon run`, deferred realpath and abandoned/pendingEnd fixes, daemon-e2e proc test and harness-daemon-e2e.mjs (RESULT pass, alive:false 11802 ms).
- Review iteration 1: sd-reviewer fix-then-merge (1 MAJOR component start failure kills daemon and leaks lock; 6 MINOR). sd-security-reviewer gate FAIL (3 HIGH: unchecked SessionStart transcript_path now live, SubagentStop root derived from untrusted path, SubagentStart session_id traversal; 1 MEDIUM TOCTOU; 3 LOW). All sent to sd-executor-probe; D-S2-10 recorded.
- cd74a67, 68c38dd, 04e3da6, e672834 fix iteration-1 findings. Iteration 2: sd-reviewer fix-then-merge (1 MAJOR: raw-path pre-check prunes legit sessions when projects dir is behind a symlink/junction; 1 MINOR nlink only checked at track time). sd-security-reviewer gate FAIL (1 HIGH: root re-resolved every check, so replacing projects with a link to ~ escapes D-S2-10; 1 MEDIUM nlink not checked on the opened handle; 1 LOW no handle identity check, FIFO DoS). Combined design for iteration 3 (last): pin the real root and its identity, compare resolved paths only, fstat the opened handle (isFile, nlink===1, dev/ino match), O_NONBLOCK.
