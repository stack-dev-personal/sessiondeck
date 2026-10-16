# S0b - Fixtures and reducer finalization

Phase 0. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for the fixture slice of Phase 0 of sessiondeck. Read docs/planning/phases/phase-0-contract.md and packages/contract/src/state.ts. I have run the capture hook for a day; raw payloads were written by the capture tool to its directory under local app data (%LOCALAPPDATA%/sessiondeck/capture/raw/<event>/<epoch-ms>-<8-char session id prefix>-<random suffix>.json), and the uninstaller's copy command (scripts/UNINSTALL.txt step 5) puts a copy at packages/contract/fixtures/raw/ (gitignored, never committed). Read the copy in packages/contract/fixtures/raw/; do not read the app-data directory itself.

Goal: scrub secrets and paths from the raw fixtures into packages/contract/fixtures/ (keep one representative per event per distinct shape, at least 50 total across at least 12 events, plus 20 statusLine samples including at least one with rate_limits), finalize every TODO(fixture) transition in reduce(), and produce the golden state timeline test for one real session.

Branch p0/fixtures. Delegate scrubbing and tests to sd-executor-contract; run sd-security-reviewer on the fixture set before commit (it must confirm no tokens, no absolute user paths beyond a placeholder, no file contents from private repos). Run sd-verifier for R0.2, R0.3, R0.4, R0.7. Record the Claude Code version and the list of hook payload fields actually observed in docs/CONTRACT.md.

Stop and ask me if a payload shape contradicts docs/planning/01-architecture.md section 3. End with the contract commit SHA that S1, S2, S3, S5 will build against.
