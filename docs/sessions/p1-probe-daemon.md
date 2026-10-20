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
| U2 | transcript tailer: main + subagent, byte offset, compaction/rotation reset (inode; ctime+size on Windows), persisted offsets, transcript harness | R1.6 | sd-executor-probe | packages/probe/src/daemon/transcript*, packages/probe/test/**, packages/probe/scripts/** | U1 |
| U3 | liveness: pid registry from hook liveness lines, 10 s kill(pid,0), ~/.claude/sessions second opinion, findParentPID/cleanupSamePID port | R1.7 | sd-executor-probe | packages/probe/src/daemon/liveness*, packages/probe/test/** | U1 |
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

## Units

### U1 daemon core (R1.4, R1.5)
- Commits 9466783, 5075a58, 950883e; review round 1 fixes 17cb010, round 2 fixes f563f93; round 3: sd-reviewer merge, sd-security-reviewer gate pass.
- Verify (d31fc8f, docs/VERIFY-P1.md): R1.4 FAIL, because lock-race.proc "exactly one of 8 simultaneous starters wins" failed in 4 of 5 runs (2 or 3 winners), so stale-lock takeover is not exclusive. R1.5 counted as FAIL because only the compressed 15 s outage ran; the full 10 min `SD_OUTAGE_MS=600000` run is due at session close.
- New task U1-fix-lock: the executor began reworking src/daemon/lock.ts into generation-numbered lock files (no remove or rename on takeover) plus three test files. Uncommitted when the run died.

### Restart 2026-10-20 ~14:20Z
- The sprint container restarted and killed the run in the middle of U1-fix-lock (not a session failure). Resumed at 14:21Z. Uncommitted diff: lock.ts (+286/-), daemon-review1.test.ts, daemon-review2.test.ts, lock-race.proc.test.ts. Decision: the generation design is sound in principle (exactly one creator per generation through link EEXIST), so sd-executor-probe finishes it rather than discarding it. Review loop restarts at iteration 1 for the fix.

## Deferred findings
