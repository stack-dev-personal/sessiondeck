---
name: work-unit
description: How a sessiondeck executor takes one work unit from delegation to report, and the delegation template the orchestrator must use. Use when delegating implementation or when executing a delegated unit.
---
# Work unit

## Delegation template (orchestrator fills every field)

```
Unit: <short name>
Requirements: R<phase>.<n>, ...
Allowed paths: packages/<pkg>/**, docs/<file>   (anything else is out of bounds; report, do not edit)
Context to read first: <phase doc section>, <architecture section>, <contract file>
Borrow: <repo> <path> (<license>) for <what>; header comment and NOTICE line required
Proof: <the test, bench, or harness that demonstrates each requirement>
Constraints: <Windows, performance, security lines from the phase doc that apply>
Report format: files changed; commands run with output tail; tests (count, result); bench numbers if any; blocked items with why. No prose beyond that.
```

## Executor loop

1. Read the listed context. Do not start from memory of similar projects; this repo's contract and phase doc win.
2. Plan in five lines or fewer: files to touch, the test that proves it, the one risk. If the plan needs a file outside the allowed paths, stop and report.
3. Write the test first when the requirement is behavioral (reducer transitions, tailer offsets, ingest validation, keyboard behavior). Write the bench harness first when the requirement is a number.
4. Implement. Borrowed code gets the header comment (source repo, path, license, what changed) and a `NOTICE` line. AGPL sources are read for behavior and rewritten.
5. Run: `pnpm -F <pkg> test`, `pnpm -F <pkg> typecheck`, `pnpm -F <pkg> lint`. Fix until green. Never skip a failing test to get green.
6. Self-check against the phase doc's Blockers/Constraints list for this unit. Windows units: forward slashes in anything written to settings, exec form `node` + `args`, `windowsHide: true`, no inode assumptions, nothing to stdout from hook paths.
7. Report in the required format. State plainly what you did not do.

## Rules that apply to every unit
- No network from executors. If a doc must be verified, say so; the orchestrator calls sd-researcher.
- No edits to `~/.claude/settings.json`; tests use `CLAUDE_CONFIG_DIR` pointed at a temp dir.
- Small commits on the session branch are fine; the orchestrator squashes nothing, the PR carries them.
