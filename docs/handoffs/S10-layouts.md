# S10 - Layouts

Phase 6. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 6 of sessiondeck. Read docs/planning/phases/phase-6-layouts.md, docs/planning/03-design-system.md section 5.4, and docs/BOARD-FEEDBACK.md.

Goal: layout engine (split tree, typed panes, JSON spec), seven builtin presets, auto-fit by count and by project, saved layouts with hotkeys 1-9 persisted in the hub, drag and keyboard pane assignment, Shift+C compact-all with exact restore, screenshot tests at two resolutions. Requirements R6.1 to R6.6.

Branch p6/layouts. Delegate to sd-executor-web; use react-resizable-panels unless it blocks the compact-all restore, then hand-roll. sd-reviewer per unit; sd-verifier runs the six-pane 20-deltas/s trace and writes docs/LAYOUTS.md with screenshots. End with PR URL and evidence.
