# Session log: p5/archive-import (S9b)

- Date: 2026-10-28
- Handoff: docs/handoffs/S09-s9b-atlas.md (S9b part: R5.2, R5.3)
- Base: sprint/3-organize at 73252da (S9 merged); contract commit 2426e6d
- Orchestrator: sd-orchestrator, headless, sprint 3

## Tasks
| Unit | Executor | Requirements | Blocked by | Status |
|------|----------|--------------|------------|--------|
| U1 contract: `archive` kind, ArchivePayload schema, 20 vault fixtures, CONTRACT.md | sd-executor-contract | R5.2, R5.3 | - | pending |
| U2 probe: archive importer component, frontmatter parser, incremental index, bench 293 files | sd-executor-probe | R5.2 | U1 | pending |
| U3 hub: ingest `archive`, merge with live record by session_id, idempotent upsert, search | sd-executor-hub | R5.3, R5.2 (hub side idempotence) | U1 | pending |
| U4 probe: harness importer -> real hub (20 fixtures, idempotent, < 10 s; live+archive merge) | sd-executor-probe | R5.2, R5.3 | U2, U3 | pending |
| U5 web: Playwright flow, screenshots of merged/archived sessions | sd-executor-web | R5.3 | U3 | pending |

## Decisions made
- D-S9b-1: envelope stays `v: 1`; `archive` is added to EVENT_KINDS without changing any field (phase doc's preferred path; no version change, so the handoff's stop condition does not trigger).
- D-S9b-2: real vault captures are not reachable in the sprint container (no vault mount, none in repo). Fixtures are 20 synthetic files built from the phase doc field list (schema_version 2, session_id, date, duration, tools_used, commits, prs, outcome text), clearly labelled synthetic. The parser is tolerant (unknown keys ignored, missing keys null). Confirming against real captures is listed for the user.
- D-S9b-3: no new runtime dependency in the probe (it is zero-dep by design and bundled to exes); a restricted YAML frontmatter parser is hand-written. gray-matter/yaml not used.

## Units

## Deferred findings

### U1 contract (sd-executor-contract) - review iteration 1
- Commit 08456c3. Reviewer: fix-then-merge (MAJOR caps vs 1 MiB ingest limit; MAJOR hub accepts archive unvalidated and leaks open-session slots -> U3). Security: Gate pass, MEDIUM strict payload, MEDIUM redaction -> U2, MEDIUM merge on (host, session_id) -> U3.
- Carried forward: U2 must redact outcome/title/commits/prs and parse YAML timestamps as strings; U3 must validate with ArchiveEnvelopeSchema, skip reduceOne/admit for archive in ingest and replay, merge on (host, session_id), bound params and FTS MATCH quoting.
- Iteration 2 (0367b27): reviewer `merge`; security `Gate: pass`. Contract tests 1145 pass / 1 skip; fixture-leak-check PASS (264 files).
- Requirement verification deferred to after U4 (contract layer alone cannot prove R5.2/R5.3).
- Carried into U2: null out invalid dates instead of failing the payload; CRLF to LF and trim list items/title before validation.
- Status: done (review), verification pending U4.

## Deferred findings (U1)
- LOW scripts/lib/fixture-leak-core.mjs:104,155-159: non-golden .json/.jsonl under vault paths get no structure check (no such files today).
- LOW packages/contract/src/archive.ts:63-71: DEL, C1, bidi overrides pass text fields; handled at render time in U5.
- LOW docs/planning/phases/phase-5-atlas.md:28 names real Windows user folders; outside S9b scope.

### U2 probe importer (sd-executor-probe) - review iteration 1
- Commit 0c4962a. Tests 368 pass / 1 skip; bench 293 files run1 276 ms, run2 0 shipped.
- Reviewer: fix-then-merge (BLOCKING invalid archive config stops forwarding; MAJOR outbox not synced before index write; MAJOR install/wiring untested; MAJOR junction root). Security: Gate fail (HIGH URL credential and connection string redaction gaps; MEDIUM intermediate symlink escape; MEDIUM config).
- Decision D-S9b-4: the configured root may itself be a link (user chose it): resolve realpath once; every directory and file below must stay inside that realpath; intermediate links refused and counted. Resolves the reviewer/security disagreement.
- Iteration 2 (de1237c): reviewer `merge` (no findings); security `Gate: pass` with 2 MEDIUM redaction gaps, fixed in a246a11 (iteration 3): security `Gate: pass`, LOWs only. Tests 405 pass / 1 skip; bench 293 files 521 ms through a real outbox.
- Status: done (review), verification after U4.

## Deferred findings (U2)
- LOW redact.ts:91-93,108-121 pass ordering (CLI_FLAG/UPPER_ENV can consume ENV_LINE anchor: `--password = x`, `X_TOKEN api_key: x`): folded into U4.
- LOW redact.ts:57-60 BLOCK_HEAD misses trailing comment, tag, leading-quote key: folded into U4.
- LOW redact.ts:90-93 open-ended CLI credential forms (--user=u:p, -uuser:pass, --api_key, mysql -pSECRET): tracked gap for S7 (Phase 4 redaction absorbs archive redactor).
- LOW importer.ts:298 open()/realpath TOCTOU window (0 leaks in 3000-flip race; attacker already has vault write): deferred.
