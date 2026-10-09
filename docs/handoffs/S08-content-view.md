# S8 - Content view

Phase 4. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 4 (view side) of sessiondeck. Read docs/planning/phases/phase-4-content.md, docs/planning/03-design-system.md section 5.3, and the merged normalizer and hub transcript API.

Goal: /session/:id route with a virtualized message list, tool call views per the design system (Edit/Write diffs with line numbers, Bash output, Read excerpt, Grep/Glob results, Agent threads nested with their own state dot, task snapshots, AskUserQuestion card), thinking collapsed, raw-row fallback, files-touched panel, and the first split view (strip above, content below). Requirements R4.5, R4.6, R4.8.

Branch p4/content-view. Delegate to sd-executor-web in units: list and transformer wiring; tool views; files panel and split. Port Crystal's ToolCallView/ToolCallGroup/MessageSegment/TodoListDisplay (MIT) and modernize. sd-reviewer per unit; sd-verifier opens a 5 MB fixture transcript and records initial render time. Serve on localhost:5173. End with PR URL and evidence.
