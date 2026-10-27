---
id: 'sessiondeck-open-decisions'
title: 'sessiondeck: Open decisions and defaults'
collection: 'sessiondeck'
type: planning
status: draft
created: 2026-10-08
---
# Open decisions and defaults

Every question that was not answered before planning started, with the default the plan assumes. Overrule any line and the affected docs are listed so the change can be propagated. Decisions you already made are listed first so nothing drifts.

## Decided (by you, 2026-10-08)

| # | Decision | Where it binds |
|---|----------|----------------|
| D1 | Sessions run on the laptop. The dedicated box hosts the dashboard and, later, the RAG and DB services. | Architecture (laptop/box split), Phase 1, Phase 2, Phase 7 |
| D2 | MVP is observe-only (model "b"). Hosting sessions inside the app is a later scaling phase (model "c"). | Roadmap (Phase 8 last), Phase 8; amended 2026-10-19 (decision 16, ADR 0010): Phase 7 is last, Phase 8 second to last |
| D3 | Cloudflare will front the box when it migrates off the LAN. | Phase 7 (Tunnel + Access), security model |
| D4 | Adopt and improve open-source code where possible; reference snippets explicitly. | Architecture "Borrow map", every phase's Inputs |
| D5 | GSD is no longer used. Planning docs follow your own section list, not a framework. | All docs |
| D6 | Dev workflow: feature branches, local ports for visual testing, push to prod only on explicit ask. | Session map, executor agents |
| D7 | Supabase is the database backend (stated 2026-10-08). SQLite stays the Phase 2 local store; Phase 7 targets Supabase Postgres (self-hosted on the box or cloud, chosen at S11). Supabase MCP gets full permissions in project settings when that work starts. | ADR 0006, Phase 2 storage, Phase 7, `docs/PERMISSIONS.md` |
| D8 | Bash is allowed project-wide; a PreToolUse guard hook and deny rules carry the hard limits (no force push, no push to main, no branch delete, no hard reset, no edits to the user-level Claude settings). | ADR 0007, `.claude/settings.json`, `docs/PERMISSIONS.md` |

## Defaults taken (overrule freely)

| # | Question | Default assumed | If you change it |
|---|----------|-----------------|------------------|
| A1 | Project name | `sessiondeck` (placeholder; "deck" because the layouts are the point) | Rename folder, `collection` frontmatter, package scopes |
| A2 | Terminal and runtime on the laptop | Native Windows `claude.exe` in Windows Terminal, Git Bash installed. WSL2 treated as a stretch target in Phase 1. Amended 2026-10-19 (decisions 17, 19): Claude sessions also run in WSL2 on the laptop. The WSL2 Linux build of the probe plus a loopback bridge to the hub on Windows moves from stretch to required in Phase 1 (R1.11, open question 2). Native Windows stays first-class. | Phase 1 Scope; probe install docs |
| A3 | Two user profiles (`C:\Users\stack` vault, `C:/Users/estac` harness sessions) | Two machines; both run the probe, one box aggregates. The probe carries a `host` field from day one. Amended 2026-10-19 (decision 17): the user states the second machine is the MacBook (M2 Pro, macOS Sonoma), which is also the box. | Nothing structural; the envelope already has `host` |
| A4 | Plan type | claude.ai Pro/Max. `rate_limits` (5h/7d) is only present on Pro/Max; on an API key those indicators show "n/a", nothing else breaks. | Phase 3 indicator set |
| A5 | Claude Code version | ≥ 2.1.251 (needed for `rate_limits` and `prompt_cache` in statusLine). Phase 0 verifies with `claude --version` and captures real payloads as fixtures. | Phase 0 Inputs |
| A6 | Metric priority for the MVP board | In order: state (working / waiting on permission / idle / error / exited), context % used, 5h and 7d usage, active subagents, task progress, cost, model + effort, branch/worktree, elapsed time, last assistant message. | Phase 3 Requirements |
| A7 | Alerts on blocked or idle sessions | Yes: visual (card state + badge) in MVP; browser notification and sound opt-in in Phase 3. | Phase 3 Scope |
| A8 | History persistence | Yes. Events and statusline snapshots persist in SQLite from Phase 2; the move to Supabase Postgres is part of Phase 7 (D7). | Phase 2 storage, Phase 7 |
| A9 | Code location | New monorepo `sessiondeck` (pnpm workspaces: `packages/probe`, `packages/hub`, `packages/web`, `packages/contract`, `infra/`). agentic-harness is a consumer and a reference, not the home, because its hooks capture at SessionEnd and this needs sub-second events. The probe will coexist with harness hooks in `~/.claude/settings.json`. | Architecture repo layout; Phase 0 |
| A10 | Planning docs location | This set lives in the vault at `projects/sessiondeck/`. Copy `planning/` to the repo's `docs/planning/` on the scaffold branch in Phase 0; the vault copy stays the index. | Phase 0 DoD |
| A11 | Agent definitions | Project-scoped `.claude/agents/*.md` in the repo (not a plugin). Models: orchestrator and reviewers on Opus, executors and verifier on Sonnet, researcher on Sonnet. Fable where you have it available for the orchestrator. | `agents/` folder |
| A12 | Handoff prompt shape | One prompt per session in the session map, self-contained, naming the phase doc, the agents to use, and the DoD. No framework commands. | `04-session-map.md` |
| A13 | CI/CD | GitHub Actions: lint, typecheck, unit tests on Linux; probe tests also on a `windows-latest` job (the probe is Windows-first). Docker build for hub+web. No Electron until Phase 8, so no Windows GUI runner needed before then. | Phase 0, Phase 7 |
| A14 | Transcript content shipped off the laptop | Yes, tailed by byte offset and shipped to the box (needed for the content view). Transcripts can contain file contents and secrets; the box is yours and LAN-only in MVP, Cloudflare Access later. Redaction of `.env`-looking lines is a Phase 4 requirement. | Phase 1 (tailer), Phase 4, security model |
| A15 | Probe runtime | Node script invoked in hook exec form (`"command": "node", "args": [...]`). ~50-80 ms per hook. If that latency is noticeable on PreToolUse, swap to a Bun-compiled single `.exe` (same code). Measured in Phase 1 Instruments. | Phase 1 |
| A16 | Store for MVP | SQLite (better-sqlite3) with a schema written to migrate cleanly to Supabase Postgres (D7). | Phase 2, Phase 7 |
| A17 | UI stack | React + Vite + TypeScript, Tailwind for tokens, Zustand for client state, WebSocket for live updates, REST for history. Matches your default React stack; no Next.js because there is no server rendering need. | Phase 3 |
| A18 | Hosting path | Phase 2 runs hub+web in Docker on the laptop (localhost). Phase 7 moves the same compose stack to the box, adds Cloudflare Tunnel + Access, Supabase Postgres, backups. Amended 2026-10-19 (decision 16, ADR 0010): harbor (Phase 7) is the last stage, after Phase 8; until it runs, hub and web stay on the laptop. The box is an always-on M2 Pro laptop that stays on macOS (decision 15), Docker through a macOS runtime, linux/arm64 containers. | Phase 7, Phase 8, MINI-SPRINT-ORDER.md |
| A19 | Session hosting mechanism (Phase 8) | Claude Agent SDK `query()` for programmatic sessions and node-pty + xterm.js for an interactive pane. Running those on the laptop (where the repos are) means a laptop-side "runner" service; the box only brokers. Amended 2026-10-19 (ADR 0010): until Phase 7 the hub on the laptop brokers. | Phase 8 |
| A20 | Archived sessions (vault `sessions/` captures from agentic-harness) in the UI | Yes, read-only, in Phase 5 via a small importer that reads the vault markdown frontmatter. Not via the harness RAG. | Phase 5 |
| A21 | Toggle to icon | Carried over from the overlay idea as "compact mode" for session cards and the whole board (one keypress). | Design system, Phase 6 |
| A22 | Target date | None given. Session map assumes evenings/weekends; each phase sized to 1-3 sessions. | Session map |

### Notes

**A15 note, 2026-10-27.** On 2026-10-21 the laptop hook bench measured the Node hook at p95 235.2 ms, p50 152 ms (200 runs) against the < 80 ms target, and a bare `node -e 0` at p95 95.2 ms, so no Node-hosted hook can meet R1.1 there. Sprint 1 was merged to main (PR #13) with this as a known Windows gap on the user's approval, on condition that the probe is not installed for real until the exe lands. Session A15 (branch p1/hook-exe) switched the per-invocation commands (hook, statusline, subagents) to Bun 1.4.4 compiled single-file exes of the same code, installed in exec form under the probe home, with `probe install --runtime node` as the fallback. New numbers on the loaded laptop (15 Docker containers, CPU 34-68%): hook.exe p95 80.5 / 79.6 / 79.9 ms over three rounds (p50 69-72 ms); a bare Bun hello-world exe p95 61-62 ms (the floor); the Node hook in the same hour p95 136.8 ms; statusline exe p95 121.0 ms against Node 143.6 ms. User decision 2026-10-27 (option B): on native Windows R1.1 is judged at hook p95 < 100 ms (the phase doc's SessionEnd ceiling). The conductor runs a quiet-laptop bench with the user before the real install, for the record.

**A2 note, 2026-10-27.** The user said: "they run on windows with subagents being connected to wsl2 containers for development and testing." Reading: every Claude Code session runs natively on Windows, so every hook and statusline call fires on native Windows. WSL2 is only Docker Desktop's backend for the containers the sessions use. No Claude Code session runs inside a WSL2 distro on this laptop. This narrows decisions 17 and 19, which assumed sessions run in WSL2. The linux-x64 exe build stays (reused by containers and a later Mac or Linux host). The WSL2-distro install and bridge part of R1.11 is not applicable to the current setup. No R1.11 code or tests are deleted.

## Questions still worth answering before Phase 1 starts

1. Is Git Bash installed on the laptop? (Decides whether statusLine runs through Git Bash or PowerShell; the exec-form probe avoids the issue for hooks but statusLine has no exec form.)
2. Do you run any sessions inside WSL2 today? If yes, Phase 1 gains a Linux build of the probe and a loopback bridge. Answered 2026-10-19 (decisions 17, 19): yes. Phase 1 gains the WSL2 Linux build and loopback bridge (R1.11); native Windows stays first-class.
   - Note, 2026-10-27: the user said "they run on windows with subagents being connected to wsl2 containers for development and testing." Every Claude Code session runs natively on Windows; WSL2 is only Docker Desktop's backend for the containers. No session runs inside a WSL2 distro here, so the WSL2-distro install and bridge part of R1.11 is not applicable to the current setup. The linux-x64 exe build stays. See the A2 note under the table above.
3. Does the box exist yet, and what OS? (Phase 7 assumes Linux with Docker.) Answered 2026-10-19 (decisions 14, 15): an always-on Apple laptop, M2 Pro, staying on macOS; Phase 7 plans for a macOS host with linux/arm64 containers. Decision 17 (2026-10-19): macOS Sonoma; the box is the MacBook, also the second machine.
4. Does agentic-harness already register hooks on `PreToolUse`/`PostToolUse`? Two hooks on the same event run in parallel, which is fine, but the per-event budget is shared on `SessionEnd` (1.5 s).
