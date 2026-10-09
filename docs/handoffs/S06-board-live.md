# S6 - Board live

Phase 3. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 3 (live) of sessiondeck. Read docs/planning/phases/phase-3-board.md, the merged packages/web and packages/hub, and docs/planning/01-architecture.md section 3.4.

Goal: WS client with reconnect and initial resync, rAF-coalesced store updates, attention sorting and host/project filters, alerts (reorder, accent, opt-in browser notification and sound), disconnect banner, Playwright smoke in CI, accessibility pass with the design:accessibility-review checklist. Requirements R3.1, R3.3, R3.6, R3.9 plus re-verify R3.7.

Branch p3/board-live. Delegate to sd-executor-web; sd-reviewer per unit; sd-verifier runs the 20-session 20-deltas/s trace against the local hub from docker compose. I will use it for three days afterward; create docs/BOARD-FEEDBACK.md with a template for me to fill. End with PR URL and evidence.
