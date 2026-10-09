---
id: 'sessiondeck-phase-6'
title: 'Phase 6: Layouts (presets)'
collection: 'sessiondeck'
type: phase
phase: 6
status: planned
depends_on: [3]
---
# Phase 6: Layouts

## MVP
Pick a layout from a menu and the board arranges itself: by session count (1, 2, 2x2, 3+1 focus, 6-grid) and by project split (one column or tab per project). Save your own, name them, switch with a key. Any pane can be a board strip, a session content view, or a project column.

## Scope
In:
- Layout engine: a tree of splits (row/column, ratios) with leaf panes typed `board | session | project | metrics`; serializable JSON spec stored in `layouts`.
- Builtin presets: `solo` (1 content + strip), `pair` (2 content side by side), `quad` (2x2), `focus` (1 large + 3 small), `grid6`, `by-project` (one column per project with that project's sessions stacked), `strip` (compact board only, for a second monitor edge).
- Auto-fit: "arrange for N live sessions" picks the preset by count; "split by project" groups.
- Saved layouts: name, hotkey slot (1-9), pin per host.
- Pane assignment: drag a session card onto a pane, or let auto-fit assign by attention order.
- Compact everything: `Shift+C` collapses every pane to its strip form (the original "toggle down to an icon").
Out:
- Multi-window (browser tabs are the multi-window). Free-form resize persistence beyond ratios. Layout sync across devices (comes free with the hub storing layouts, but no conflict handling).

## Blockers / constraints
- Content panes are heavy (virtualized lists); 6 live content panes must still hit 60 fps during tool bursts; panes not visible unmount their list.
- Ratios and pane types must round-trip through the JSON spec without loss (golden tests).
- Keyboard-first: every layout action has a key; mouse is optional.

## Inputs
- Phase 3 feedback doc; Phase 4 content view.
- Crystal `frontend/src/components/panels/{PanelContainer,PanelTabBar}.tsx` (MIT) as the panel model seed.
- Zellij's pinned floating panes and tmux layouts as the mental model for presets (research notes in `01-architecture.md` lineage).

## Instruments
- `react-resizable-panels` or a hand-rolled split tree (decide in session; the former is fine).
- Playwright: screenshot each preset at 1440x900 and 2560x1440.

## Requirements
- R6.1 All seven builtin presets render correctly at both test resolutions and survive reload.
- R6.2 Auto-fit picks the expected preset for 1-6 live sessions (table-driven test).
- R6.3 Saved layouts persist in the hub, switch in < 100 ms, hotkeys 1-9 work.
- R6.4 Six content panes live at 20 deltas/s: no dropped frames (trace).
- R6.5 `Shift+C` compacts all panes; `Shift+C` again restores the previous layout exactly.
- R6.6 Drag-assign and keyboard-assign both work; a session can appear in at most one content pane.

## Definition of done
- [ ] All R6.x pass; preset screenshots in `docs/LAYOUTS.md`.
- [ ] You use a saved layout for a real multi-project evening and record what was missing in `docs/BOARD-FEEDBACK.md`.
- [ ] `sd-reviewer` sign-off.
