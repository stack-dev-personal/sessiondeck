---
id: 'sessiondeck-phase-5'
title: 'Phase 5: Atlas (organization and navigation)'
collection: 'sessiondeck'
type: phase
phase: 5
status: planned
depends_on: [3]
---
# Phase 5: Atlas

## MVP
Sessions are organized the way you think about them: Project → Phase → Session, with live and archived sessions side by side, searchable. Projects are inferred from `project_dir` and named once. Archived sessions come from the vault's `sessions/` captures written by agentic-harness.

## Scope
In:
- Projects: auto-created from `workspace.project_dir` (statusLine) or `cwd`; editable name, color, vault collection link; worktrees roll up to their parent repo.
- Phases: a lightweight label on a session (set from the session's name, a `phase` hook field if you add one, or by hand in the UI); phase list per project.
- Session list view: filters (host, project, phase, state, date), sort, keyboard navigation (`j`/`k`, `Enter`).
- Archive importer: reads vault `projects/*/sessions/*.md` and `harness/*/sessions/*.md` frontmatter (session_id, date, duration, tools_used, commits, prs, outcome text) into the hub as `archived` sessions; links a live session to its archive entry by `session_id` when the harness writes it at SessionEnd.
- Search: SQLite FTS5 over session names, last prompts, last messages, archive outcome text; later over transcript text if cheap.
- Navigation: command palette (`Ctrl+K`) to jump to a session, project, or phase.
Out:
- Writing to the vault (read-only import). Task/issue tracking. Cross-project analytics beyond counts.

## Blockers / constraints
- The vault lives on the laptop; the box cannot read it directly. Importer runs in the probe daemon (laptop side) and ships archive records as `kind: 'archive'` envelopes (add to contract, version bump to `v: 2` if the envelope changes; prefer adding a kind without changing fields).
- Two machines, two vault paths (`C:\Users\stack\vault`, `C:/Users/estac/...`): importer paths are per-host config.
- Session names from Claude Code (`session_name`) are AI titles unless you `/rename`; the UI must let you rename without touching Claude.

## Inputs
- Vault session capture format: `harness/agentic-harness/sessions/*.md` frontmatter (`schema_version: 2`, fields listed in `01-architecture.md` is not enough; copy one real file into fixtures).
- Phase 3 feedback doc.
- claudecodeui's project/session sidebar behavior (AGPL, spec only) for what people expect from a session list.

## Instruments
- SQLite FTS5; gray-matter (frontmatter parsing); cmdk or a hand-rolled palette.
- Importer golden test from 20 real vault files (scrubbed).

## Requirements
- R5.1 Every live session belongs to exactly one project; worktree sessions roll up to the repo project.
- R5.2 Archive import is idempotent and incremental (by file mtime); 293 harness files import in under 10 s.
- R5.3 Live session and its archive entry merge into one record after the harness writes the capture.
- R5.4 Search returns results in < 100 ms for your data size; palette navigates with keyboard only.
- R5.5 Phase labels are editable inline and survive hub restart.
- R5.6 Project view shows: live sessions, last 20 archived, totals (sessions, hours, cost from history), active branches.

## Definition of done
- [ ] All R5.x pass.
- [ ] Your real projects (bb2dash, quant-edge, agentic-harness, this one) appear named and colored with their archives attached.
- [ ] `docs/ATLAS.md`: how projects and phases are inferred, how to fix a mis-assignment.
- [ ] `sd-reviewer` sign-off.
