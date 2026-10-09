# S2 - Probe daemon

Phase 1. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 1 (daemon side) of sessiondeck. Read docs/planning/phases/phase-1-probe.md, docs/planning/01-architecture.md section 4.2, packages/contract at <sha>, and the spool format implemented on branch p1/probe-hook (read its src/spool.ts; if that branch is not merged yet, build against packages/contract's spool line schema and note it).

Goal: probe-daemon with spool tailer and persisted cursor, batching, retry with backoff and jitter, transcript tailer (main and subagent transcripts, byte offset, compaction reset by ctime+size on Windows), pid liveness every 10 s with ~/.claude/sessions second opinion, host heartbeat, and Task Scheduler registration on Windows. Requirements R1.4, R1.5, R1.6, R1.7.

Branch p1/probe-daemon. Delegate to sd-executor-probe. Port cctop's poller offset logic and ccmonitor's findParentPID/cleanupSamePID with attribution. For the hub, use a stub HTTP server in tests that can be killed and restarted; the loss harness must show 500 sent, 500 accepted, 0 duplicates. sd-reviewer per unit; sd-verifier runs the loss and transcript harnesses.

Stop and ask me if the daemon needs anything outside %LOCALAPPDATA% or admin rights. End with PR URL and evidence.
