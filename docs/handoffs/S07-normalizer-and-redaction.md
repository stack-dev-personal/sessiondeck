# S7 - Normalizer and redaction

Phase 4. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 4 (data side) of sessiondeck. Read docs/planning/phases/phase-4-content.md, docs/planning/01-architecture.md section 3.5, and five full transcript fixtures I have placed in packages/contract/fixtures/transcripts/ (one with subagents, one with a compaction).

Goal: contract/normalize.ts producing UnifiedMessage[] from raw JSONL rows (parentUuid branch pruning, isSidechain separation, subagent attachment by agent_id, compaction dividers, streaming message.id replacement, raw fallback for unknown rows), hub transcript endpoints and WS transcript deltas, and the probe redaction filter with the two test corpora. Requirements R4.1, R4.2, R4.3, R4.4, R4.7.

Branch p4/normalize. Delegate normalizer and hub to sd-executor-hub, redaction to sd-executor-probe. Port Crystal's ClaudeMessageTransformer (MIT) as the seed; vibe-kanban's NormalizedEntryType shape (Apache-2.0, add NOTICE). sd-reviewer per unit; sd-security-reviewer on redaction (0 leaks on the secret corpus is the gate). sd-verifier writes docs/TRANSCRIPT-FORMAT.md listing every row type handled with its fixture. Stop and ask me if a row type in the fixtures has no sensible rendering. End with PR URL and evidence.
