# ADR 0004: Adopt and improve open source; cite code; AGPL as spec only

Status: accepted 2026-10-08

## Context
Several projects already solve parts of this (hook state machines, transcript tailing, JSONL cost accounting, message rendering, pty session managers). The best transcript/session UI code (claudecodeui) is AGPL-3.0.

## Decision
Borrow MIT and Apache-2.0 code with header attribution and NOTICE entries; read AGPL and unlicensed projects for behavior only. The borrow map in `docs/planning/01-architecture.md` section 9 is the source of truth; `/borrow-code` is the procedure.

## Consequences
- The repository stays MIT-cleanable.
- Some components (transcript viewer) are ports of archived MIT code (Crystal) rather than forks of the most active project.
- Revisit if the repo will stay private forever: a direct claudecodeui fork would shortcut Phases 2 to 4.
