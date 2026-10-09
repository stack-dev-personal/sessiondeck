# sessiondeck

A self-hosted dashboard for running many Claude Code sessions in parallel: live state, context window, 5h/7d usage, cost, subagents and task progress per session; the content each session is working on; organization by project and phase; preset layouts.

Status: planning complete, development not started. First session is `docs/handoffs/S00-contract-and-scaffold.md`.

## How it works, in one paragraph

A small probe on the laptop turns Claude Code's hook and statusLine callbacks into a stream of JSON envelopes (spool on disk, forwarded in batches so a hook never waits on the network) and tails transcripts by byte offset. A hub on a dedicated box ingests the stream, reduces it into session snapshots with a documented state machine, stores history, and pushes deltas over WebSocket to a React board. Later phases add the content view, projects and archive, layouts, hosting behind Cloudflare Access, and launching sessions from the app.

## Documents

| Doc | Purpose |
|-----|---------|
| `docs/planning/00-open-decisions.md` | Decisions made and defaults assumed |
| `docs/planning/01-architecture.md` | Components, contract, state machine, storage, security, borrow map with code citations |
| `docs/planning/02-roadmap.md` | Nine phases, dependencies, parallel lanes |
| `docs/planning/03-design-system.md` | Tokens, states, meters, card anatomy, keyboard model |
| `docs/planning/04-session-map.md` | Sessions, order, parallelism, handoff prompts |
| `docs/planning/phases/` | Per-phase MVP, scope, constraints, inputs, instruments, requirements, definition of done |
| `docs/handoffs/` | One paste-ready prompt per development session |
| `docs/decisions/` | Architecture decision records |
| `docs/research/` | Dated research notes with sources |
| `.claude/agents/` | Scoped subagents: orchestrator, executors, reviewers, verifier, researcher |

## Starting a development session

```
cd sessiondeck
claude --agent sd-orchestrator
```

Then paste the body of the matching file in `docs/handoffs/`. `CLAUDE.md` tells the session the rest.

## License

MIT for this repository's own code. Third-party attributions in `NOTICE`.
