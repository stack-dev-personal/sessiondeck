# Session log: p0/fixtures (S0b)

- Date: 2026-10-15
- Handoff: docs/handoffs/S00b-fixtures-and-reducer-finalization.md
- Branch: p0/fixtures from sprint/0-bootstrap at 6baa15c (origin/sprint/0-bootstrap is also 6baa15c at intake)
- Contract SHA at start: 6baa15c (no contract commit for Sprint 0; this session produces it)
- Capture: Claude Code 2.1.301, Windows 11 Home 10.0.26200, one working day (2026-10-15), 3807 raw files, five sessions in five project directories. Raw copy at packages/contract/fixtures/raw/ (gitignored, never committed, never quoted).
- Requirements: R0.1, R0.2, R0.3, R0.4, R0.7 (handoff names R0.2, R0.3, R0.4, R0.7; R0.1 has a "pending S0b" row)

## Task list

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|------------|-------|
| U1 fixture inventory, scrub, select (scripts plus scrubbed set, README) | R0.7 | sd-executor-contract | none | running |
| U2 captured-fixture walks (envelope, statusLine) and CONTRACT.md observed payloads | R0.1, R0.4, R0.7 | sd-executor-contract | U1 | pending |
| U3 reducer TODO(fixture) finalization and golden timeline | R0.2, R0.3 | sd-executor-contract | U1 | pending |
| U4 conductor decisions: ADR docker socket, PROMPT-BOOK section 6, entrypoint export, capture path docs, guard rule, Read deny rules | decisions 1, 3, 4, 5 | sd-executor-contract (widened scope) | none | running |
| Close: rebase, full suite, VERIFY-P0 rows incl. laptop confirmations, PR | all | sd-verifier | U1-U4 | pending |

## Decisions made

Conductor decisions (C:/Users/stack/projects/sessiondeck/.sprint/0/answers/decisions.md, recorded 2026-10-15T14:14:37Z):
1. Docker socket mount accepted by the user. Sibling-container model stays. ADR to be written in this session (U4).
2. R0.5 scope confirmed: sprint tooling tests stay in their own CI step. No change.
3. Docs unit folded into S0b (U4): PROMPT-BOOK section 6 gains the green sprint state; headless prompts say subagent calls stay in the foreground; session status heartbeat at least every 15 minutes; infra/sprint/entrypoint.sh exports CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 before the headless claude call, with a test.
4. S0 open questions at defaults: keep SessionSnapshot.tracking; keep pid in liveness payloads (envelope unchanged); raw captures default to the capture tool's directory under local app data (handoff and fixture-capture skill updated in U4 with the real file name shape: epoch-ms, short session id, random suffix); hub host check and 400 semantics deferred to S3.
5. Guard rule blocking capture-install.mjs --apply from any session, and Read deny rules for the capture directory in the project settings (U4).
6. Capture day done (2026-10-15).
7. Task-list fixtures synthetic: TaskCreated and TaskCompleted were not captured (task tools disabled on this machine). Also synthetic by decision: PermissionDenied (default permission mode), StopFailure. Stated in the fixture README and docs/VERIFY-P0.md.

Scope widening for this session (conductor): sd-executor-contract may edit .claude/hooks/guard.mjs (with test), the deny list of .claude/settings.json, .claude/skills/fixture-capture/SKILL.md, docs/handoffs/S00b-fixtures-and-reducer-finalization.md, PROMPT-BOOK.md, docs/decisions/, infra/sprint/entrypoint.sh (with test). sd-security-reviewer gates every diff under .claude/ and infra/.

Laptop confirmations handed to this session (to record in docs/VERIFY-P0.md): R0.8 live smoke PASS 2026-10-15 (green 16.2 s after container start, evidence .sprint/0/gate/smoke-evidence-run2.txt); capture installer real install and uninstall from a plain terminal, backups beside the user-level settings file, exec-form hooks fire, no _capture-errors.log; project guard hook still fires with the capture hook installed.

## Units

## Deferred findings
