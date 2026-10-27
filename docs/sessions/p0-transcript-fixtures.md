# Session log: p0/transcript-fixtures (FX-T)

- Date: 2026-10-27
- Handoff: conductor prompt for fixture session FX-T (prerequisite for Sprint 2, S7 input; docs/handoffs/S07-normalizer-and-redaction.md)
- Branch: p0/transcript-fixtures from main at 2426e6d (contract commit 2426e6d089fb0ae9339e8e3fc5001eccc5cb191e; main has not moved)
- Requirement: R0.7 (fixtures scrubbed, security gate), transcript extension
- Repo is public: every committed byte is published. User decision 2026-10-27: only sessiondeck's own development transcripts, scrubbed by script, user reviews the PR before merge.
- Headless, local run; state directory C:/Users/stack/projects/sessiondeck/.sprint/1/

## Task list

| Unit | Requirements | Executor | Blocked by | State |
|------|--------------|----------|------------|-------|
| U1 transcript inventory script, run over candidates, choose five | R0.7 | sd-executor-contract | none | pending |
| U2 scrub transcript mode, write five fixtures plus per-fixture README | R0.7 | sd-executor-contract | U1 | pending |
| U3 leak check transcript mode, tests for scrub and leak check | R0.7 | sd-executor-contract | U2 | pending |
| U4 fixtures README Transcripts section | R0.7 | sd-executor-contract | U3 | pending |
| U5 security gate, review, verify, push, PR | R0.7 | sd-security-reviewer, sd-reviewer, sd-verifier | U4 | pending |

## Decisions made

## Units

## Deferred findings

### U1 transcript inventory (R0.7)
- Executor sd-executor-contract, commit 1e0ccdd: scripts/transcript-inventory.mjs, scripts/lib/transcript-inventory-core.mjs, scripts/test/transcript-inventory.test.ts (11 tests, synthetic input, asserts no values leak into output), docs/research/2026-10-27-transcript-inventory.md. Scripts suite 336 pass, typecheck, lint, prettier clean.
- 21 candidates inventoried (1 skipped as modified in the last 30 minutes, the live conductor session excluded), 48056 rows, 217 subagent files. Versions 2.1.295 to 2.1.311.
- Chosen by exhaustive 5-subset search (must include subagents and a compaction, most structural features, ties to smaller size): 01-subagents (2.16 MB, 4 subagents), 02-subagents-compaction (4.48 MB, 1), 03-compaction (5.98 MB), 04-compaction (7.11 MB), 05-subagents (11.85 MB, 12; only source of hook_non_blocking_error and read_truncation_notice). Raw copies in packages/contract/fixtures/raw/transcripts/ (gitignored, 0 tracked).
- Gaps: no candidate holds /clear, /compact or /resume, or a resume marker; no image, document or redacted_thinking blocks. The scrub still handles images and documents by rule, tested on synthetic input.
- 282 key names not in fixture-keys.mjs (shallow walk); includes userEmail, organizationUuid, systemPrompt and request-body keys, which the scrub must classify before allowing.
- Review: per the handoff, sd-reviewer and sd-security-reviewer review the whole tooling diff at step 5 (U5).

Decision (orchestrator): fixture ids (uuid, parentUuid, sessionId, message.id, tool_use ids, agentId) are kept verbatim, not remapped as in S0b. They are random identifiers, not personal data, and S7 needs every cross-file link intact; remapping risks breaking a link held in an unlisted field. Account, org, user and request identifiers become placeholders.
Decision (orchestrator): the scrubbed transcripts are committed only after the security gate passes (as S0b did). U2 commits tooling only; the fixture files stay untracked until U5.

### U2 transcript scrub mode (R0.7)
- Executor sd-executor-contract, commit 6a4c07b (tooling only): `--transcripts` in scripts/fixture-scrub.mjs, scripts/lib/transcript-scrub-{core,rules,text,literals,run,readme}.mjs, TRANSCRIPT_KEY_REASONS and TRANSCRIPT_KEYS in fixture-keys.mjs (hook-mode KNOWN_KEYS untouched), mapEncodedFolder in fixture-scrub-paths.mjs, packages/contract/test/helpers.ts excludes transcripts, scripts/test/transcript-scrub.test.ts (30 tests, synthetic).
- Results: scripts 365 pass, 1 fail (fixture-gate.test.ts, because the hook-mode leak check scans the new untracked transcripts directory; passes 34/34 with it moved aside; U3 fixes); contract 1091 pass; typecheck, lint, prettier clean. Two scrub runs byte-identical.
- Output (untracked): 01 606 rows 0.67 MB, 02 1754 rows 1.44 MB, 03 3548 rows 2.91 MB, 04 4561 rows 3.84 MB, 05 4059 rows 3.92 MB; 12.8 MB total from 31.6 MB.
- Dropped to `<BLOB n>`: wire and request bodies, classifier request and context, system prompts, tool schemas, hook additional context, file backups, rawContent, diagnostics.
- Executor-reported residue, sent to U3 as blocking: fragments of the user's email local part and git account name survive inside some free text (substring sweep missing for account names); hookName is numbered, which loses a structural value.
- Process: the first heartbeat was killed by the 10-minute default background limit during U2, so the status file went without updates for about 15 minutes. Restarted with a 60-minute limit.

### U3 transcript leak check (R0.7)
- Resumed 2026-10-27 after the conductor paused the session mid-U3 (about 19:25Z); the uncommitted WIP was kept and finished, not discarded.
- Executor sd-executor-contract, commit 83f984b (tooling and tests only): transcript mode in scripts/fixture-leak-check.mjs via scripts/lib/transcript-leak-{core,raw,search,structure}.mjs and shared scripts/lib/fixture-leak-patterns.mjs; hook mode now skips transcripts/ (fixes fixture-gate.test.ts); scrub fixes in scripts/lib/transcript-scrub-{fragments,folders,hookname}.mjs (account-name fragments of 5+ chars swept as substrings, non-public folder names to `<DIR>`, hookName keeps `<HookEvent>` or `<HookEvent>:<built-in tool>`, else `<NAME_n>`). New tests scripts/test/transcript-leak.test.ts (23) and scripts/test/transcript-scrub-account.test.ts (20).
- Results: scripts 409 pass, 2 skipped (pre-existing); fixture-gate 34/34; contract 1091 pass; typecheck, lint, prettier clean. Scrub run twice, tree sha256 prefix 001fcf9426c83e46 both times. Leak check (rerun by orchestrator): 257 files, 44 transcript files, 14545 rows, 0 findings, exit 0.
- Fixtures still untracked until the U5 security gate.
- Residual risks for U5: the kept 120-char prefixes may hold names or code no rule recognizes (security reviewer to sample); raw-derived literal checks run only locally (CI has no raw/), same design as S0b; executor's "rows" count is summed across all files of a fixture (05 session.jsonl alone is 387 rows), to reconcile in the per-fixture READMEs in U4.
