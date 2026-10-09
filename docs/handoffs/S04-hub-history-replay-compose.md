# S4 - Hub history, replay, compose

Phase 2. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 2 (history) of sessiondeck. Read docs/planning/phases/phase-2-hub.md, docs/planning/01-architecture.md sections 5.3, 5.4, and the merged packages/hub.

Goal: transcript usage aggregation with ccusage v19.0.3's dedup and LiteLLM pricing (MIT, attribute; fetch cached at startup, optional), statusline_samples retention, hub replay command, 30-day event compaction, infra/docker-compose.yml running hub and the web static build, load harness. Requirements R2.4, R2.9, R2.10.

Branch p2/hub-history. Delegate to sd-executor-hub; sd-reviewer per unit; sd-verifier runs the load harness at 1k envelopes/s and the cost comparison against ccusage on the same transcripts, writing docs/HUB-BENCH.md. Stop and ask me if cost differs from ccusage by more than 1% and the cause is not a pricing-table version. End with PR URL and evidence.
