---
id: 'sessiondeck-phase-8'
title: 'Phase 8: Cockpit (session hosting)'
collection: 'sessiondeck'
type: phase
phase: 8
status: planned
depends_on: [2, 3]
---
# Phase 8: Cockpit

## MVP
From the app: pick a project, a worktree or branch, a model, and a handoff prompt, and a new Claude Code session starts on the laptop and appears on the board like any other. Open a terminal pane to it in the browser. This is model "c" from the decision log: the hub brokers (on the laptop until harbor, then the box), the laptop runs.

## Scope
In:
- `packages/runner` (laptop daemon, sibling of the probe or merged into it): accepts launch requests from the hub over the existing authenticated channel (hub → runner via a long-lived outbound WS from the runner, so still no inbound ports on the laptop), spawns sessions two ways:
  - programmatic: Claude Agent SDK `query()` with `cwd`, `model`, `permissionMode`, `resume`, streaming SDK messages back as `transcript`-like envelopes (claude-code-webui `backend/handlers/chat.ts`, MIT, is the 100-line reference);
  - interactive: node-pty spawning `claude` with the handoff prompt, streaming pty bytes to an xterm.js pane in the browser over a dedicated WS path (Crystal `AbstractCliManager.ts`, MIT, for spawn/line-buffering/process-tree kill; claudecodeui `shell-websocket.service.ts`, AGPL, spec only).
- Launcher UI: project → worktree (create via `git worktree add`, Crystal `worktreeManager.ts` MIT) → model/effort → handoff prompt (from a library you maintain in the repo, one per phase of each project) → go.
- Terminal pane as a layout pane type (`terminal`), with input; permission prompts answered in the terminal pane.
- Session control: stop, resume by id, rename, open in Windows Terminal (launch `wt.exe` with `claude --resume <id>`).
- Optional Electron shell (`packages/electron`): wraps the web app, adds a tray icon with attention count, global hotkey to raise the board. Only if you still want it after using the browser version.
Out:
- Hosting sessions on the box (your repos stay on the laptop). Multi-user. Agent teams orchestration (track `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` separately).

## Blockers / constraints
- Built before Phase 7 (ADR 0010): during this phase the hub runs on the laptop (Docker; on the laptop, localhost or LAN bind, see ADR 0010), so the runner channel stays on the laptop side and the controls are the hub bearer token and the runner's channel authentication. Phase 7 re-runs this phase's security review with the hub reachable through Cloudflare Access before harbor merges (R7.10).
- A runner that spawns processes on request is remote code execution by design; it only accepts commands from the hub over the mutually authenticated channel, only runs `claude` (no arbitrary commands), only in allow-listed project roots, and logs every launch. The security review is the gate.
- Windows pty is ConPTY via node-pty; Claude Code's mouse-mode and scrollback quirks apply inside xterm.js (the overlay research). Acceptable for a secondary pane; the primary terminal stays Windows Terminal.
- SDK-launched sessions do not appear in `claude --resume` pickers unless targeted by id; the board must surface the id.
- Two laptops (A3): the launcher picks a host.

## Inputs
- claude-code-webui `backend/handlers/chat.ts` (MIT) SDK streaming; Crystal `main/src/services/panels/cli/AbstractCliManager.ts`, `claudeCodeManager.ts` `buildCommandArgs`, `worktreeManager.ts`, `frontend/.../TerminalPanel.tsx` (MIT).
- Claude Agent SDK docs (TypeScript): `query()`, `getContextUsage()`, `sessionId`, `resume`, `hooks` in-process.
- Your handoff prompt library (starts with the ones in `04-session-map.md`).

## Instruments
- `@anthropic-ai/claude-agent-sdk`, `node-pty` (`useConptyDll` on Windows), `@xterm/xterm` + addons.
- Launch harness: 10 SDK sessions and 3 pty sessions started and stopped in sequence; assert each appears on the board with the right project and ends cleanly.

## Requirements
- R8.1 Runner accepts launch only from the hub channel; unauthenticated or malformed requests are logged and dropped; executable is hard-coded to `claude`.
- R8.2 Launch from UI to card on board < 3 s; SDK session shows context via `getContextUsage()` when statusLine is absent.
- R8.3 Terminal pane round-trips keystrokes with < 50 ms added latency against the hub (the laptop hub in Phase 8; re-measured through the box in Phase 7); resize propagates; closing the pane does not kill the session.
- R8.4 Worktree creation is idempotent and refuses to create outside allow-listed roots.
- R8.5 "Open in Windows Terminal" opens a new tab resumed on the right session id.
- R8.6 Every launch is recorded as an event with who/what/where, visible in the session's history.
- R8.7 (Electron, if built) tray attention count matches the board; global hotkey raises the window.

## Definition of done
- [ ] All R8.x pass; launch harness green locally on the laptop.
- [ ] One real phase of another project run end to end from the launcher with its handoff prompt.
- [ ] `docs/COCKPIT.md`: runner security model, allow-lists, how to add a handoff prompt.
- [ ] `sd-security-reviewer` sign-off is the gate.
