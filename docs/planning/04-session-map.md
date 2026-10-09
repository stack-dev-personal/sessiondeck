---
id: 'sessiondeck-session-map'
title: 'sessiondeck: Session map and handoff prompts'
collection: 'sessiondeck'
type: planning
status: draft
created: 2026-10-08
---
# Session map

How the work is cut into Claude Code sessions, the order, what can run at the same time, which agents each session uses, and the handoff prompt that starts it. Each session is the project manager for its slice: it reads the phase doc, builds a task list, delegates work units to executor subagents, runs the review loop, and stops at the Definition of Done.

## 1. Operating model

- Start every session with the project agent so the PM session cannot write code itself: `claude --agent sd-orchestrator` (the agent definition scopes tools to read, search, shell, task list, and delegation). Paste the handoff prompt as the first message.
- Work unit loop inside a session: `sd-executor-<area>` implements on a branch → `sd-reviewer` reviews the diff (and `sd-security-reviewer` where the phase says so) → executor fixes → `sd-verifier` runs the phase's requirement checks → PM marks the unit done.
- Branch per session: `p<phase>/<slug>` (e.g. `p1/probe-hook`). Local ports for visual checks. No push to `main` without your word; the PM ends by reporting the PR URL and the DoD checklist with evidence.
- Context hygiene: the PM session never reads large files itself; executors do. If the PM's context passes ~60% (your board will tell you once Phase 3 exists), it writes `docs/HANDOFF-<session>.md` with state and stops; a fresh session resumes from that file.
- Stop-and-ask conditions (apply to every session): a decision in `00-open-decisions.md` turns out wrong; a borrowed snippet's license is not what the doc says; a Claude Code payload differs from the fixtures; anything that would push to `main`, delete data, or change `~/.claude/settings.json` beyond the probe's own keys.

## 2. Sessions, order, parallelism

| Session | Phase | Slice | Branch | Executors | Reviewers | Runs after | Parallel with |
|---------|-------|-------|--------|-----------|-----------|------------|---------------|
| S0 | 0 | monorepo, CI, contract package, fixture capture script, agents, docs copy | `p0/scaffold` | sd-executor-contract | sd-reviewer, sd-security-reviewer (fixtures) | nothing | nothing |
| S0b | 0 | you: run the capture hook for a working day, then the session commits scrubbed fixtures and finalizes `reduce()` | `p0/fixtures` | sd-executor-contract | sd-security-reviewer | S0 + one day of your sessions | nothing |
| S1 | 1 | probe-hook, probe-statusline, spool, install/uninstall, latency bench | `p1/probe-hook` | sd-executor-probe | sd-reviewer, sd-security-reviewer | S0b | S2, S3, S5 |
| S2 | 1 | probe-daemon: forwarder, cursor, transcript tailer, liveness, Task Scheduler registration | `p1/probe-daemon` | sd-executor-probe | sd-reviewer | S0b | S1, S3, S5 |
| S3 | 2 | hub core: ingest, store, reducer wiring, REST, WS, Dockerfile | `p2/hub-core` | sd-executor-hub | sd-reviewer, sd-security-reviewer | S0b | S1, S2, S5 |
| S4 | 2 | hub history: ccusage dedup/pricing port, samples, retention, replay, compose | `p2/hub-history` | sd-executor-hub | sd-reviewer | S3 | S5, S6 |
| S5 | 3 | board on mocks: shell, tokens, card, drawer, compact, `/dev/cards` | `p3/board-mock` | sd-executor-web | sd-reviewer | S0b | S1, S2, S3 |
| S6 | 3 | board live: WS client, alerts, sorting/filtering, Playwright, a11y pass | `p3/board-live` | sd-executor-web | sd-reviewer | S3, S5 | S4 |
| S7 | 4 | normalizer in contract/hub, transcript API, redaction in probe | `p4/normalize` | sd-executor-hub, sd-executor-probe | sd-reviewer, sd-security-reviewer (redaction) | S2, S4 | S9, S10 |
| S8 | 4 | content view in web, files-touched panel, split view | `p4/content-view` | sd-executor-web | sd-reviewer | S6, S7 | S9, S10 |
| S9 | 5 | projects, phases, session list, palette, FTS | `p5/atlas-core` | sd-executor-web, sd-executor-hub | sd-reviewer | S6 | S7, S8, S10 |
| S9b | 5 | archive importer (probe side) + merge logic (hub) | `p5/archive-import` | sd-executor-probe, sd-executor-hub | sd-reviewer | S9 | S10 |
| S10 | 6 | layout engine, presets, saved layouts, compact-all | `p6/layouts` | sd-executor-web | sd-reviewer | S6 | S7, S8, S9 |
| S11 | 7 | box provisioning runbook, Docker on box, Postgres migration + import, backups | `p7/box` | sd-executor-infra, sd-executor-hub | sd-security-reviewer, sd-reviewer | S4 | S7-S10 |
| S12 | 7 | Cloudflare Tunnel + Access, LAN override, hardening checklist with evidence | `p7/edge` | sd-executor-infra | sd-security-reviewer (gate) | S11 | S7-S10 |
| S13 | 8 | runner daemon: hub channel, SDK launch, pty launch, allow-lists, launch log | `p8/runner` | sd-executor-probe | sd-security-reviewer (gate), sd-reviewer | S12 | S14 (UI on mocks) |
| S14 | 8 | launcher UI, terminal pane, handoff prompt library, open-in-WT | `p8/cockpit-ui` | sd-executor-web | sd-reviewer | S10, S13 | S13 (mocks first) |
| S15 | 8 | Electron shell (optional) | `p8/electron` | sd-executor-web | sd-reviewer | S14 | nothing |

Critical path: S0 → S0b → S3 → S6 → S8. Everything else hangs off that line. The widest parallel moment is right after S0b: four sessions (S1, S2, S3, S5) in four terminals, which is exactly the situation the tool exists for.

## 3. Handoff prompts

Each prompt is self-contained. Replace `<sha>` with the contract commit after S0b. Paste as the first message of a session started with `claude --agent sd-orchestrator` in the repo root.

### S0 - Contract and scaffold

```
You are the project manager for Phase 0 of sessiondeck. Read, in order: docs/planning/00-open-decisions.md, docs/planning/01-architecture.md (sections 3, 8, 9), docs/planning/phases/phase-0-contract.md, docs/planning/03-design-system.md (section 2 only, for the tokens file location).

Goal: a pnpm monorepo that builds and tests in CI on ubuntu and windows, with packages/contract implemented and unit-tested (envelope schema, state machine reducer, snapshot type, statusLine schema from ccstatusline's StatusJSON.ts), a scripts/capture-fixtures.mjs that registers on all 17 hook events plus statusLine and dumps raw payloads to packages/contract/fixtures/raw/<event>/, and .claude/agents/ populated from docs/agents/.

Work on branch p0/scaffold. Create a task list from the phase doc's Requirements (R0.1 to R0.7). Delegate implementation to sd-executor-contract in work units no larger than one package or one CI workflow each. After each unit, run sd-reviewer on the diff; when fixtures are produced, run sd-security-reviewer on them before any commit. Finish with sd-verifier executing every R0.x check and producing docs/VERIFY-P0.md with command and output per requirement.

Constraints: hooks in exec form on Windows must use "command": "node" with "args"; the capture hook must merge into ~/.claude/settings.json without touching existing hooks; nothing writes stdout from a hook. Do not finalize reduce() transition cases that depend on unverified payload fields; mark them with a TODO(fixture) and a failing-skipped test.

Stop and ask me if: any decision in 00-open-decisions.md looks wrong in practice, a license differs from the borrow map, or you need to push to main. End with: PR URL, DoD checklist with evidence, and the list of fixture events still missing so I can run S0b.
```

### S0b - Fixtures and reducer finalization

```
You are the project manager for the fixture slice of Phase 0 of sessiondeck. Read docs/planning/phases/phase-0-contract.md and packages/contract/src/state.ts. I have run the capture hook for a day; raw payloads are in packages/contract/fixtures/raw/.

Goal: scrub secrets and paths from the raw fixtures into packages/contract/fixtures/ (keep one representative per event per distinct shape, at least 50 total across at least 12 events, plus 20 statusLine samples including at least one with rate_limits), finalize every TODO(fixture) transition in reduce(), and produce the golden state timeline test for one real session.

Branch p0/fixtures. Delegate scrubbing and tests to sd-executor-contract; run sd-security-reviewer on the fixture set before commit (it must confirm no tokens, no absolute user paths beyond a placeholder, no file contents from private repos). Run sd-verifier for R0.2, R0.3, R0.4, R0.7. Record the Claude Code version and the list of hook payload fields actually observed in docs/CONTRACT.md.

Stop and ask me if a payload shape contradicts docs/planning/01-architecture.md section 3. End with the contract commit SHA that S1, S2, S3, S5 will build against.
```

### S1 - Probe hook and statusline

```
You are the project manager for Phase 1 (hook side) of sessiondeck. Read docs/planning/phases/phase-1-probe.md, docs/planning/01-architecture.md section 4, and packages/contract at <sha>.

Goal: packages/probe with dist/hook.mjs, dist/statusline.mjs, dist/subagents.mjs (esbuild single files), the spool writer, probe install/uninstall (idempotent settings.json merge, config at %LOCALAPPDATA%\sessiondeck\probe.json), and scripts/bench-hook.mjs reporting p50/p95. Requirements R1.1, R1.2, R1.3, R1.8, R1.9, R1.10.

Branch p1/probe-hook. Delegate to sd-executor-probe. Borrow with attribution: agents-observe hook.sh pattern, ccstatusline Windows UTF-8 handling, Claude-Code-Usage-Monitor atomic write. Run sd-reviewer per unit and sd-security-reviewer on the settings merge and the token file handling. sd-verifier runs the bench and the 50-process concurrency test and writes docs/PROBE-BENCH.md.

Constraint: if p95 > 80 ms, do not optimize blindly; report numbers and stop so I can decide on the Bun .exe variant (decision A15). Do not install into my real settings.json during development; use CLAUDE_CONFIG_DIR pointed at a scratch dir for tests. End with PR URL and evidence.
```

### S2 - Probe daemon

```
You are the project manager for Phase 1 (daemon side) of sessiondeck. Read docs/planning/phases/phase-1-probe.md, docs/planning/01-architecture.md section 4.2, packages/contract at <sha>, and the spool format implemented on branch p1/probe-hook (read its src/spool.ts; if that branch is not merged yet, build against packages/contract's spool line schema and note it).

Goal: probe-daemon with spool tailer and persisted cursor, batching, retry with backoff and jitter, transcript tailer (main and subagent transcripts, byte offset, compaction reset by ctime+size on Windows), pid liveness every 10 s with ~/.claude/sessions second opinion, host heartbeat, and Task Scheduler registration on Windows. Requirements R1.4, R1.5, R1.6, R1.7.

Branch p1/probe-daemon. Delegate to sd-executor-probe. Port cctop's poller offset logic and ccmonitor's findParentPID/cleanupSamePID with attribution. For the hub, use a stub HTTP server in tests that can be killed and restarted; the loss harness must show 500 sent, 500 accepted, 0 duplicates. sd-reviewer per unit; sd-verifier runs the loss and transcript harnesses.

Stop and ask me if the daemon needs anything outside %LOCALAPPDATA% or admin rights. End with PR URL and evidence.
```

### S3 - Hub core

```
You are the project manager for Phase 2 (core) of sessiondeck. Read docs/planning/phases/phase-2-hub.md, docs/planning/01-architecture.md sections 3.4, 5.1, 5.2, 7, and packages/contract at <sha>.

Goal: packages/hub (Fastify, better-sqlite3, ws): POST /ingest with bearer auth, zod validation, id and signature dedup, per-batch transaction; reducer wiring for all envelope kinds; migrations for the schema in 5.1; REST routes for sessions, hosts, projects; WS /stream with initial resync and heartbeat; Dockerfile. Requirements R2.1, R2.2, R2.3, R2.5, R2.6, R2.7, R2.8.

Branch p2/hub-core. Delegate to sd-executor-hub. Borrow claude-watch broadcast and agents-observe event-signature with attribution; treat claudecodeui as spec only (AGPL). Golden tests: replay contract fixture sequences and compare snapshots. sd-reviewer per unit; sd-security-reviewer on auth, validation, and SQL parameterization. sd-verifier runs the WS harness with 5 clients.

Keep the hub stateless apart from the DB; Phase 7 copies it to another machine unchanged. Stop and ask me before adding any outbound network call. End with PR URL and evidence.
```

### S4 - Hub history, replay, compose

```
You are the project manager for Phase 2 (history) of sessiondeck. Read docs/planning/phases/phase-2-hub.md, docs/planning/01-architecture.md sections 5.3, 5.4, and the merged packages/hub.

Goal: transcript usage aggregation with ccusage v19.0.3's dedup and LiteLLM pricing (MIT, attribute; fetch cached at startup, optional), statusline_samples retention, hub replay command, 30-day event compaction, infra/docker-compose.yml running hub and the web static build, load harness. Requirements R2.4, R2.9, R2.10.

Branch p2/hub-history. Delegate to sd-executor-hub; sd-reviewer per unit; sd-verifier runs the load harness at 1k envelopes/s and the cost comparison against ccusage on the same transcripts, writing docs/HUB-BENCH.md. Stop and ask me if cost differs from ccusage by more than 1% and the cause is not a pricing-table version. End with PR URL and evidence.
```

### S5 - Board on mocks

```
You are the project manager for Phase 3 (mock) of sessiondeck. Read docs/planning/phases/phase-3-board.md, docs/planning/03-design-system.md in full, docs/planning/01-architecture.md section 6, and packages/contract at <sha>.

Goal: packages/web (React 18, Vite, TypeScript, Tailwind on the CSS-variable tokens, Zustand) with the app shell, tokens.css, the session card exactly per the design system (fixed 6-row geometry, compact 1-row form, attention accent), the detail drawer, keyboard model, theme toggle, and a /dev/cards route that renders every state and meter threshold from contract fixtures. VITE_MOCK=1 replays fixtures through reduce() in the browser. Requirements R3.2, R3.4, R3.5, R3.7, R3.8.

Branch p3/board-mock. Delegate to sd-executor-web in units: tokens and shell; card; drawer; dev route and screenshot tests. sd-reviewer per unit with the design system as the checklist. sd-verifier runs contrast checks for both themes and the Playwright screenshot suite. Serve on localhost:5173 and tell me when to look. Stop and ask me if a token or threshold in the design system cannot meet AA contrast. End with PR URL, screenshots, and evidence.
```

### S6 - Board live

```
You are the project manager for Phase 3 (live) of sessiondeck. Read docs/planning/phases/phase-3-board.md, the merged packages/web and packages/hub, and docs/planning/01-architecture.md section 3.4.

Goal: WS client with reconnect and initial resync, rAF-coalesced store updates, attention sorting and host/project filters, alerts (reorder, accent, opt-in browser notification and sound), disconnect banner, Playwright smoke in CI, accessibility pass with the design:accessibility-review checklist. Requirements R3.1, R3.3, R3.6, R3.9 plus re-verify R3.7.

Branch p3/board-live. Delegate to sd-executor-web; sd-reviewer per unit; sd-verifier runs the 20-session 20-deltas/s trace against the local hub from docker compose. I will use it for three days afterward; create docs/BOARD-FEEDBACK.md with a template for me to fill. End with PR URL and evidence.
```

### S7 - Normalizer and redaction

```
You are the project manager for Phase 4 (data side) of sessiondeck. Read docs/planning/phases/phase-4-content.md, docs/planning/01-architecture.md section 3.5, and five full transcript fixtures I have placed in packages/contract/fixtures/transcripts/ (one with subagents, one with a compaction).

Goal: contract/normalize.ts producing UnifiedMessage[] from raw JSONL rows (parentUuid branch pruning, isSidechain separation, subagent attachment by agent_id, compaction dividers, streaming message.id replacement, raw fallback for unknown rows), hub transcript endpoints and WS transcript deltas, and the probe redaction filter with the two test corpora. Requirements R4.1, R4.2, R4.3, R4.4, R4.7.

Branch p4/normalize. Delegate normalizer and hub to sd-executor-hub, redaction to sd-executor-probe. Port Crystal's ClaudeMessageTransformer (MIT) as the seed; vibe-kanban's NormalizedEntryType shape (Apache-2.0, add NOTICE). sd-reviewer per unit; sd-security-reviewer on redaction (0 leaks on the secret corpus is the gate). sd-verifier writes docs/TRANSCRIPT-FORMAT.md listing every row type handled with its fixture. Stop and ask me if a row type in the fixtures has no sensible rendering. End with PR URL and evidence.
```

### S8 - Content view

```
You are the project manager for Phase 4 (view side) of sessiondeck. Read docs/planning/phases/phase-4-content.md, docs/planning/03-design-system.md section 5.3, and the merged normalizer and hub transcript API.

Goal: /session/:id route with a virtualized message list, tool call views per the design system (Edit/Write diffs with line numbers, Bash output, Read excerpt, Grep/Glob results, Agent threads nested with their own state dot, task snapshots, AskUserQuestion card), thinking collapsed, raw-row fallback, files-touched panel, and the first split view (strip above, content below). Requirements R4.5, R4.6, R4.8.

Branch p4/content-view. Delegate to sd-executor-web in units: list and transformer wiring; tool views; files panel and split. Port Crystal's ToolCallView/ToolCallGroup/MessageSegment/TodoListDisplay (MIT) and modernize. sd-reviewer per unit; sd-verifier opens a 5 MB fixture transcript and records initial render time. Serve on localhost:5173. End with PR URL and evidence.
```

### S9 / S9b - Atlas

```
You are the project manager for Phase 5 of sessiondeck. Read docs/planning/phases/phase-5-atlas.md and the merged web and hub.

Goal (S9): projects inferred from project_dir with worktree roll-up, editable name/color, phase labels, session list with filters and keyboard navigation, Ctrl+K palette, SQLite FTS5 search. Requirements R5.1, R5.4, R5.5, R5.6.
Goal (S9b, separate session after S9): archive importer in the probe daemon reading vault session captures (fixture: 20 scrubbed files from harness/agentic-harness/sessions/), shipped as kind 'archive' envelopes, merged with live records by session_id in the hub. Requirements R5.2, R5.3.

Branches p5/atlas-core and p5/archive-import. Delegate web units to sd-executor-web, hub units to sd-executor-hub, importer to sd-executor-probe. sd-reviewer per unit; sd-verifier checks import idempotence and search latency. Stop and ask me before changing the envelope version. End with PR URL and evidence.
```

### S10 - Layouts

```
You are the project manager for Phase 6 of sessiondeck. Read docs/planning/phases/phase-6-layouts.md, docs/planning/03-design-system.md section 5.4, and docs/BOARD-FEEDBACK.md.

Goal: layout engine (split tree, typed panes, JSON spec), seven builtin presets, auto-fit by count and by project, saved layouts with hotkeys 1-9 persisted in the hub, drag and keyboard pane assignment, Shift+C compact-all with exact restore, screenshot tests at two resolutions. Requirements R6.1 to R6.6.

Branch p6/layouts. Delegate to sd-executor-web; use react-resizable-panels unless it blocks the compact-all restore, then hand-roll. sd-reviewer per unit; sd-verifier runs the six-pane 20-deltas/s trace and writes docs/LAYOUTS.md with screenshots. End with PR URL and evidence.
```

### S11 / S12 - Harbor

```
You are the project manager for Phase 7 of sessiondeck. Read docs/planning/phases/phase-7-harbor.md, docs/planning/01-architecture.md section 7, and infra/.

Goal (S11): box provisioning runbook (Linux, Docker, deploy user, default-deny firewall), the compose stack on the box, Supabase Postgres (self-hosted on the box or cloud; decide and record the trade-off at the start of S11) with migrations ported from SQLite, one-shot history import with row-count verification, nightly pg_dump with an off-box copy, restore drill script. Requirements R7.3, R7.4.
Goal (S12, after S11): cloudflared as a compose service, Cloudflare Access policies (identity for web, service token for /ingest), probe and web LAN override, WS heartbeat verified through the tunnel, hardening checklist with command-and-output evidence in docs/HARDENING.md, trivy and npm audit in CI. Requirements R7.1, R7.2, R7.5, R7.6, R7.7, R7.8.

Branches p7/box and p7/edge. Delegate to sd-executor-infra (and sd-executor-hub for the Postgres port; both get the Supabase MCP tool for this phase per docs/PERMISSIONS.md). sd-security-reviewer is the gate for both sessions; sd-reviewer secondary. Verify every Cloudflare step against current docs with sd-researcher before executing; do not rely on memory. Nothing in these sessions runs against the box without me confirming the host and the SSH key first. End with PR URL and evidence.
```

### S13 / S14 / S15 - Cockpit

```
You are the project manager for Phase 8 of sessiondeck. Read docs/planning/phases/phase-8-cockpit.md, docs/planning/01-architecture.md section 7, and the merged probe, hub, and web.

Goal (S13): packages/runner on the laptop: outbound authenticated WS to the hub, launch requests validated against allow-listed project roots, SDK launch via @anthropic-ai/claude-agent-sdk query() streaming back as envelopes, pty launch via node-pty (useConptyDll) with a dedicated WS path for terminal bytes, hard-coded executable, launch log as events. Requirements R8.1, R8.2, R8.6.
Goal (S14, UI on mocks first, then live): launcher (project, worktree create, model/effort, handoff prompt library from docs/planning/04-session-map.md), terminal pane type with xterm.js, session controls, open-in-Windows-Terminal. Requirements R8.3, R8.4, R8.5.
Goal (S15, optional): Electron shell with tray attention count and global hotkey. Requirement R8.7.

Branches p8/runner, p8/cockpit-ui, p8/electron. Delegate runner to sd-executor-probe, UI to sd-executor-web. Port Crystal's AbstractCliManager, buildCommandArgs, worktreeManager, TerminalPanel (MIT) and claude-code-webui chat.ts (MIT). sd-security-reviewer is the gate for S13; sd-reviewer per unit elsewhere. Stop and ask me before the runner can execute anything, and again before it is registered to start at login. End with PR URL and evidence.
```

## 4. What you do between sessions

- After S0: run normal sessions for a day with the capture hook on (S0 tells you how).
- After S1+S2: install the probe for real and leave it for two days.
- After S6: use the board for three days and fill `docs/BOARD-FEEDBACK.md`.
- After S10: run a multi-project evening on a saved layout.
- Before S11: tell the session the box's hostname and confirm the SSH key.
- Before S13: decide whether you still want Electron (S15) after living in the browser version.
