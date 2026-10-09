---
id: 'sessiondeck-phase-1'
title: 'Phase 1: Probe (laptop telemetry)'
collection: 'sessiondeck'
type: phase
phase: 1
status: planned
depends_on: [0]
---
# Phase 1: Probe

## MVP
Every Claude Code session on the laptop emits envelopes to a local spool within milliseconds of each hook, the statusLine feed is captured on every tick, and a daemon forwards everything to the hub with no loss when the hub is unreachable. Installing it is one command.

## Scope
In:
- `probe-hook` (`dist/hook.mjs`): stdin → envelope → spool append → exit 0. Exec form registration.
- `probe-statusline` (`dist/statusline.mjs`): same append, then prints a compact one-line status so the built-in line still shows something.
- `probe-subagents` for `subagentStatusLine` (same pattern, kind `subagents`).
- `probe-daemon`: spool tailer with persisted cursor, batching, retry with backoff and jitter, transcript tailer (main + subagent transcripts) by byte offset with compaction reset, pid liveness every 10 s, `~/.claude/sessions/*.json` second opinion, host heartbeat.
- `probe install` / `probe uninstall`: idempotent edit of `~/.claude/settings.json` (merge, never clobber harness hooks), config file at `%LOCALAPPDATA%\sessiondeck\probe.json` (hub URL, token, host name), daemon registration (Task Scheduler on Windows; systemd user unit on Linux).
- Native Windows first. Linux build for WSL2 as stretch (same code, different install path).
Out:
- Any interpretation of payloads (hub's job).
- Redaction (Phase 4; the daemon ships raw transcript lines in Phase 1 to a LAN-only hub).
- OTel.

## Blockers / constraints
- statusLine has no exec form; on Windows it runs through Git Bash if present, otherwise PowerShell. Command must use forward slashes. Open question 1 in `00-open-decisions.md`.
- `SessionEnd` hooks share a 1.5 s budget; the hook must stay under 100 ms.
- Hook stdout starting with `{` is interpreted by Claude Code; the hook writes nothing to stdout.
- No `/dev/tty` for hooks on Windows; nothing interactive.
- Spool writes from parallel hooks (Claude runs matching hooks in parallel): use `O_APPEND` single-write of one line; lines under 64 KB are atomic on NTFS and Linux for practical purposes, verify with a stress test.
- Transcripts can exceed tens of MB; the tailer must never read from offset 0 on a live file except on compaction reset.
- Windows has no inode: replacement detection uses `ctime` change plus size regression.

## Inputs
- `packages/contract` at the Phase 0 SHA.
- agents-observe `hooks/scripts/hook.sh`, `lib/http.mjs` (fire-and-forget socket unref, 5 s timeout) (MIT).
- cctop `plugin/scripts/cctop-poller.py` (offset tailing) and `plugin/hooks/hooks.json` (MIT).
- ccmonitor `internal/hook/hook.go` (`findParentPID`, `cleanupSamePID`, WSL/Git Bash process chain notes), `plugin/hooks/hooks.json` (MIT, confirm LICENSE).
- Claude-Code-Usage-Monitor `output/official.py` atomic write pattern (tmp + rename) (MIT).
- ccstatusline `src/ccstatusline.ts` Windows UTF-8 code page handling (MIT).

## Instruments
- Latency harness: `scripts/bench-hook.mjs` spawns `node dist/hook.mjs` 200 times with a fixture on stdin and reports p50/p95 wall time. Target p95 < 80 ms on the laptop. If exceeded, build the Bun single-file `.exe` variant (A15).
- Loss harness: start daemon, kill hub, run 500 synthetic events, restart hub, assert 500 accepted, no duplicates.
- Transcript harness: replay a fixture transcript into a temp file in 1 KB chunks with a simulated compaction (truncate + rewrite) and assert the tailer emits every line exactly once.
- Windows CI job runs unit tests; the latency and loss harnesses run locally and record numbers in `docs/PROBE-BENCH.md`.

## Requirements
- R1.1 Hook p95 wall time < 80 ms (A15 fallback if not).
- R1.2 Hook never exits non-zero and never writes stdout, under any input including empty or malformed stdin.
- R1.3 Spool lines are complete JSON under concurrent hooks (stress test: 50 parallel hook processes, 0 corrupted lines).
- R1.4 Daemon cursor survives restart; zero duplicate `id`s and zero gaps in `seq` across a kill/restart during load.
- R1.5 Hub unreachable for 10 minutes → all envelopes delivered on reconnect, in order per host.
- R1.6 Transcript tailer delivers each line once, handles compaction and rotation, tails subagent transcripts after `SubagentStart`.
- R1.7 Liveness: a session whose pid dies without `SessionEnd` produces a `liveness` envelope within 15 s.
- R1.8 `probe install` leaves existing hooks in `settings.json` untouched (test against a settings fixture containing harness hooks) and is idempotent.
- R1.9 statusLine command prints a usable one-liner (state, context %, 5h %) and never throws.
- R1.10 Config and token live outside `settings.json` with user-only permissions.

## Definition of done
- [ ] All R1.x pass; bench numbers recorded.
- [ ] Installed on your laptop, running for two working days alongside agentic-harness with no observed slowdown and no hook errors in `claude --debug`.
- [ ] Spool for those days replays into a local hub (Phase 2 dev build) with every session reconstructed.
- [ ] `docs/PROBE.md`: install, uninstall, where files live, how to read the spool by hand.
- [ ] `sd-reviewer` and `sd-security-reviewer` sign-off (the security review covers the token file, the spool contents, and the settings merge).
