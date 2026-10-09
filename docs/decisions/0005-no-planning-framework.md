# ADR 0005: No planning framework; own section list and agents

Status: accepted 2026-10-08

## Context
A planning framework was used previously and dropped. Planning docs and agents must not depend on any framework's commands or file layout.

## Decision
Phase docs use the fixed section list (MVP, Scope, Blockers/Constraints, Inputs, Instruments, Requirements, Definition of Done). Sessions are driven by project agents (`sd-*`) and project skills (the guided loops), with paste-ready handoff prompts.

## Consequences
- Everything a session needs is in this repo.
- Requirement IDs `R<phase>.<n>` are the traceability unit across tests, reviews, verification, and PRs.
