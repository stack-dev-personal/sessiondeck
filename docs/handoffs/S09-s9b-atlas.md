# S9 / S9b - Atlas

Phase 5. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 5 of sessiondeck. Read docs/planning/phases/phase-5-atlas.md and the merged web and hub.

Goal (S9): projects inferred from project_dir with worktree roll-up, editable name/color, phase labels, session list with filters and keyboard navigation, Ctrl+K palette, SQLite FTS5 search. Requirements R5.1, R5.4, R5.5, R5.6.
Goal (S9b, separate session after S9): archive importer in the probe daemon reading vault session captures (fixture: 20 scrubbed files from harness/agentic-harness/sessions/), shipped as kind 'archive' envelopes, merged with live records by session_id in the hub. Requirements R5.2, R5.3.

Branches p5/atlas-core and p5/archive-import. Delegate web units to sd-executor-web, hub units to sd-executor-hub, importer to sd-executor-probe. sd-reviewer per unit; sd-verifier checks import idempotence and search latency. Stop and ask me before changing the envelope version. End with PR URL and evidence.
