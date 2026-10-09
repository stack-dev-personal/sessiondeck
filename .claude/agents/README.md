# sessiondeck agents

Copy this folder's `sd-*.md` files to `.claude/agents/` in the sessiondeck repo (S0 does it). They are project-scoped subagents; the PM session itself runs as `claude --agent sd-orchestrator`.

Tool names in the `tools:` frontmatter follow current Claude Code naming (`Agent`, `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`). If your build lists `Task` instead of `Agent`, or `TodoWrite` instead of the task tools, run `/agents` and adjust the names; nothing else changes.

| Agent | Model | Writes code | Network | Used by |
|-------|-------|-------------|---------|---------|
| sd-orchestrator | opus | no | no | every PM session |
| sd-executor-contract | sonnet | packages/contract, scripts, .github | no | S0, S0b |
| sd-executor-probe | sonnet | packages/probe, packages/runner | no | S1, S2, S7, S9b, S13 |
| sd-executor-hub | sonnet | packages/hub, packages/contract/normalize | no | S3, S4, S7, S9, S11 |
| sd-executor-web | sonnet | packages/web, packages/electron | no | S5, S6, S8, S9, S10, S14, S15 |
| sd-executor-infra | sonnet | infra, docs/HARBOR*, docs/HARDENING | yes (docs only via researcher) | S11, S12 |
| sd-reviewer | opus | no | no | every session |
| sd-security-reviewer | opus | no | no | S0b, S1, S3, S7, S11, S12, S13 |
| sd-verifier | sonnet | docs/VERIFY-*.md, docs/*-BENCH.md only | no | every session |
| sd-researcher | sonnet | no | yes | S0, S12, S13, anywhere a doc must be checked |

Scoping rule: an executor's description names the directories it may edit. The PM includes that boundary in every delegation prompt, and the reviewer flags any diff outside it.

Skills: the loops in `.claude/skills/` are referenced from each agent's body. If your Claude Code build supports the `skills:` frontmatter key on subagents, you can also preload them there (orchestrator: sprint-loop, work-unit, review-loop, verify-dod, session-handoff; executors: work-unit, borrow-code).

MCP tools: an agent with an explicit `tools:` list gets no MCP tools unless named. When the Supabase MCP server is added (Phase 7), append `mcp__supabase__*` to `sd-executor-hub` and `sd-executor-infra`; see `docs/PERMISSIONS.md`.
