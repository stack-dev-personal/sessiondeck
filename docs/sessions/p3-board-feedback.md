# Session log: p3/board-feedback (S8b)

- Date: 2026-10-28
- Handoff: docs/handoffs/S08b-board-feedback.md
- Sprint: 2 (content), base branch sprint/2-content
- Contract SHA: 77a4fa1ddafdc54d8e4e18e3101e654a642e767d (branch base 62d85a5 merges it)
- Note: TaskCreate is disabled in this headless session; this table is the task list.

## Tasks

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|------------|-------|
| U1 contract: subagent parent links; phase doc R3.10 to R3.13 | R3.11 (data) | sd-executor-contract | none | pending |
| U2 web: display activity hysteresis, stable order, grace setting | R3.10 | sd-executor-web | none | pending |
| U3 web: SessionPopout and AgentRollup replace the drawer | R3.11 | sd-executor-web | U1 | pending |
| U4 web: UsageWidget, meters off cards, Fable estimate | R3.12 | sd-executor-web | none | pending |
| U5 web: mock mode and Playwright evidence | R3.13 (+ screens R3.10 to R3.12) | sd-executor-web | U2, U3, U4 | pending |

Fable estimate source: hub GET /history/daily already returns per-day model_breakdowns, so no hub change is planned.

## Units

## Decisions made

## Deferred findings
