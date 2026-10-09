---
id: 'sessiondeck-research-notes'
title: 'sessiondeck: Research notes (2026-10-08)'
collection: 'sessiondeck'
type: research
status: final
created: 2026-10-08
---
# Research notes

Condensed from two documentation passes and two code-level passes run on 2026-10-08. Kept so the reasoning behind the architecture survives the people who did it. Sources are listed at the end.

## 1. Why the in-terminal overlay was dropped

The original ask was a box drawn in the top-left of the terminal running Claude Code, with hover and a collapse-to-icon toggle. Findings:

- Claude Code is an inline Ink app, not an alternate-screen app; its own status line scrolls away with output (issue #30311, closed not-planned). Only some views enter the alt screen.
- Claude Code enables mouse tracking itself (`?1000h ?1002h ?1003h ?1006h` in "full" mode) and has open bugs where motion reports leak into the prompt (#85290 and duplicates). A wrapper would have to intercept those mode writes and arbitrate every mouse event.
- On Windows a wrapper means two ConPTY layers (Windows Terminal → ConPTY → wrapper → ConPTY → claude). Classic ConPTY re-synthesizes output and has dropped mouse-mode sequences; the modern runtime (`useConptyDll`, passthrough) fixes some of it. Warp forked ConPTY to get around it.
- Windows Terminal has no overlay or status API. tmux 3.7 floating panes are new and immature; Zellij pinned floating panes work (native Windows since 0.44) but Zellij's mouse mode fights Claude's.
- Verdict table: OS-level floating window (robust hover/toggle, separate process, must track the terminal window) > Zellij pinned pane (robust, forces Zellij) > PTY wrapper (you are writing a multiplexer).

Your pivot to a separate dashboard made the whole question moot: the app does not need to sit on top of the terminal at all. The compact strip and compact-all mode in the design system preserve the "toggle down to an icon" intent.

## 2. What Claude Code exposes (the surfaces the probe uses)

| Surface | Key facts |
|---------|-----------|
| statusLine | stdin JSON with `session_id`, `transcript_path`, `cwd`, `model`, `workspace`, `cost.*`, `context_window.*` (used_percentage from input tokens of the most recent response), `exceeds_200k_tokens`, `rate_limits.five_hour/seven_day` (Pro/Max only, after first API response, dropped after `resets_at`), `prompt_cache` (v2.1.251+), `effort`, `thinking`, `pr`, `worktree`. Triggers: new assistant message, /compact, permission-mode change, `refreshInterval` (min 1 s), rate-limit reset, cache expiry. 300 ms debounce. Multi-line output allowed. No exec form; Git Bash or PowerShell on Windows. |
| subagentStatusLine | one JSON per refresh tick with `tasks[]` (id, name, type, status, model, contextWindowSize, tokenCount, tokenSamples) for rows visible in the agent panel. |
| Hooks | 33 events; the probe registers 17. Common stdin fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`; `agent_id`/`agent_type` inside subagents. Handler types: command, http, mcp_tool, prompt, agent. `async` only on command hooks. http hooks: synchronous, failures dropped silently, not allowed on SessionStart. SessionEnd budget 1.5 s shared. Exec form on Windows needs a real `.exe` (use `node`). `terminalSequence` output can set the terminal title (OSC 0/2) from a hook. |
| Transcripts | `~/.claude/projects/<encoded cwd>/<session>.jsonl`; subagents under `<session>/subagents/agent-<id>.jsonl`; large tool outputs under `<session>/tool-results/`. Format documented as internal and unstable. Assistant rows carry `message.usage` and `model` in practice. `isSidechain`, `parentUuid`, `compact_boundary` observed. |
| OTel | `CLAUDE_CODE_ENABLE_TELEMETRY=1`; metrics (token, cost, session count, lines, active time) every 60 s; events (api_request, tool_result, subagent_completed, compaction) every 5 s. No context % or rate limits. |
| Liveness | `~/.claude/sessions/*.json` (pid, status busy, procStart); `claude agents --json` (research preview) lists live sessions with pid, status, cwd, sessionId. |
| Env in children | `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, `CLAUDE_PROJECT_DIR`, `CLAUDE_EFFORT`. `CLAUDE_SESSION_ID` appears in community docs but not the official list. |
| Agent SDK | `query()` streams messages; `getContextUsage()`, `accountInfo()`, in-process hooks; starts its own sessions, cannot attach to a running terminal session. |

Unverified at research time (Phase 0 fixtures resolve): stdin field names for PostToolUse result, PostToolUseFailure, PreCompact, TaskCreated/Completed, TeammateIdle; SDK result message shapes; whether statusLine runs for SDK sessions.

## 3. Open-source candidates

| Repo | License | State (Oct 2026) | Role in this plan |
|------|---------|------------------|-------------------|
| siteboon/claudecodeui (CloudCLI) | AGPL-3.0 | very active, 13k stars | best transcript/session code; spec only, no copying |
| stravu/crystal | MIT | deprecated Feb 2026 | donor for message transformer, tool views, panel layout, pty spawn, worktrees |
| BloopAI/vibe-kanban | Apache-2.0 | sunsetting | normalized entry schema |
| sugyan/claude-code-webui | MIT | archived May 2026 | 100-line SDK streaming example |
| DeanLa/cctop | MIT | active | hook state machine, transcript tailer, format reference docs |
| martinwickman/ccmonitor | MIT (confirm) | active | pid discovery, same-pid cleanup, Windows process chains, WT tab switching |
| ccusage/ccusage | MIT | active; TS until v19.0.3, Rust from v20 | JSONL dedup, pricing, 5h block heuristic |
| Maciek-roboblog/Claude-Code-Usage-Monitor | MIT | active | rate-limit staleness and leak guards |
| sirmalloc/ccstatusline | MIT | active | statusLine zod schema, Windows handling |
| simple10/agents-observe | MIT | active | fast hook wrapper, event signature dedup, all-events hooks.json |
| NirDiamant/claude-watch | MIT | thin | WS broadcast, ingest route shape |
| appaquet/ccmon | MIT | unmaintained | best hook→state mapping (uses PermissionRequest) |
| disler/claude-code-hooks-multi-agent-observability | none | stale | design reference only |

Nothing in this set does the laptop → remote box split or shows 5h/7d per session; both come from the statusLine feed, which only ccstatusline and Claude-Code-Usage-Monitor read, and neither aggregates across sessions. That gap is the product.

## 4. Sources

- Claude Code docs: https://code.claude.com/docs/en/statusline, https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/monitoring-usage, https://code.claude.com/docs/en/sessions, https://code.claude.com/docs/en/sub-agents, https://code.claude.com/docs/en/agent-view, https://code.claude.com/docs/en/agent-sdk/overview, https://code.claude.com/docs/en/env-vars
- Overlay feasibility: https://github.com/anthropics/claude-code/issues/85290, https://claudeissues.com/issue/30311-feature-request-sticky-pinned-statusline-footer, https://vtdn.dev/docs/decset/mode1003-any-event/, https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-22-release, https://www.warp.dev/blog/building-warp-on-windows, https://zellij.dev/news/stacked-resize-pinned-panes/, https://linuxiac.com/tmux-3-7-terminal-multiplexer-released-with-initial-floating-pane-support/, https://electronjs.org/docs/latest/tutorial/custom-window-interactions
- Repos: https://github.com/siteboon/claudecodeui, https://github.com/stravu/crystal, https://github.com/BloopAI/vibe-kanban, https://github.com/sugyan/claude-code-webui, https://github.com/DeanLa/cctop, https://github.com/martinwickman/ccmonitor, https://github.com/ccusage/ccusage, https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor, https://github.com/sirmalloc/ccstatusline, https://github.com/simple10/agents-observe, https://github.com/NirDiamant/claude-watch, https://github.com/appaquet/ccmon
