# Handoff prompts

One file per session from `docs/planning/04-session-map.md`. Start the session with `claude --agent sd-orchestrator` in the repo root, then paste the prompt body. In the containerized workflow the mini-sprint orchestrator wraps each of these in the preamble from `PROMPT-BOOK.md` section 2 and runs it headless. Replace `<sha>` with the contract commit after S0b.

| File | Session | Phase |
|------|---------|-------|
| `S00-contract-and-scaffold.md` | S0 - Contract and scaffold | 0 |
| `S00b-fixtures-and-reducer-finalization.md` | S0b - Fixtures and reducer finalization | 0 |
| `S00c-sprint-tooling.md` | S0c - Sprint container tooling | 0 |
| `S01-probe-hook-and-statusline.md` | S1 - Probe hook and statusline | 1 |
| `S02-probe-daemon.md` | S2 - Probe daemon | 1 |
| `S03-hub-core.md` | S3 - Hub core | 2 |
| `S04-hub-history-replay-compose.md` | S4 - Hub history, replay, compose | 2 |
| `S05-board-on-mocks.md` | S5 - Board on mocks | 3 |
| `S06-board-live.md` | S6 - Board live | 3 |
| `S07-normalizer-and-redaction.md` | S7 - Normalizer and redaction | 4 |
| `S08-content-view.md` | S8 - Content view | 4 |
| `S09-s9b-atlas.md` | S9 / S9b - Atlas | 5 |
| `S10-layouts.md` | S10 - Layouts | 6 |
| `S11-s12-harbor.md` | S11 / S12 - Harbor | 7 |
| `S13-s14-s15-cockpit.md` | S13 / S14 / S15 - Cockpit | 8 |
