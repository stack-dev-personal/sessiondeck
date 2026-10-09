# S1 - Probe hook and statusline

Phase 1. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 1 (hook side) of sessiondeck. Read docs/planning/phases/phase-1-probe.md, docs/planning/01-architecture.md section 4, and packages/contract at <sha>.

Goal: packages/probe with dist/hook.mjs, dist/statusline.mjs, dist/subagents.mjs (esbuild single files), the spool writer, probe install/uninstall (idempotent settings.json merge, config at %LOCALAPPDATA%\sessiondeck\probe.json), and scripts/bench-hook.mjs reporting p50/p95. Requirements R1.1, R1.2, R1.3, R1.8, R1.9, R1.10.

Branch p1/probe-hook. Delegate to sd-executor-probe. Borrow with attribution: agents-observe hook.sh pattern, ccstatusline Windows UTF-8 handling, Claude-Code-Usage-Monitor atomic write. Run sd-reviewer per unit and sd-security-reviewer on the settings merge and the token file handling. sd-verifier runs the bench and the 50-process concurrency test and writes docs/PROBE-BENCH.md.

Constraint: if p95 > 80 ms, do not optimize blindly; report numbers and stop so I can decide on the Bun .exe variant (decision A15). Do not install into my real settings.json during development; use CLAUDE_CONFIG_DIR pointed at a scratch dir for tests. End with PR URL and evidence.
