# S13 / S14 / S15 - Cockpit

Phase 8. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 8 of sessiondeck. Read docs/planning/phases/phase-8-cockpit.md, docs/planning/01-architecture.md section 7, and the merged probe, hub, and web.

Goal (S13): packages/runner on the laptop: outbound authenticated WS to the hub, launch requests validated against allow-listed project roots, SDK launch via @anthropic-ai/claude-agent-sdk query() streaming back as envelopes, pty launch via node-pty (useConptyDll) with a dedicated WS path for terminal bytes, hard-coded executable, launch log as events. Requirements R8.1, R8.2, R8.6.
Goal (S14, UI on mocks first, then live): launcher (project, worktree create, model/effort, handoff prompt library from docs/planning/04-session-map.md), terminal pane type with xterm.js, session controls, open-in-Windows-Terminal. Requirements R8.3, R8.4, R8.5.
Goal (S15, optional): Electron shell with tray attention count and global hotkey. Requirement R8.7.

Branches p8/runner, p8/cockpit-ui, p8/electron. Delegate runner to sd-executor-probe, UI to sd-executor-web. Port Crystal's AbstractCliManager, buildCommandArgs, worktreeManager, TerminalPanel (MIT) and claude-code-webui chat.ts (MIT). sd-security-reviewer is the gate for S13; sd-reviewer per unit elsewhere. Stop and ask me before the runner can execute anything, and again before it is registered to start at login. End with PR URL and evidence.
