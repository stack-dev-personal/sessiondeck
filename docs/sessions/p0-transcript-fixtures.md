# Session log: p0/transcript-fixtures (FX-T)

- Date: 2026-10-27
- Handoff: conductor prompt for fixture session FX-T (prerequisite for Sprint 2, S7 input; docs/handoffs/S07-normalizer-and-redaction.md)
- Branch: p0/transcript-fixtures from main at 2426e6d (contract commit 2426e6d089fb0ae9339e8e3fc5001eccc5cb191e; main has not moved)
- Requirement: R0.7 (fixtures scrubbed, security gate), transcript extension
- Repo is public: every committed byte is published. User decision 2026-10-27: only sessiondeck's own development transcripts, scrubbed by script, user reviews the PR before merge.
- Headless, local run; state directory <HOME>/projects/sessiondeck/.sprint/1/

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

### U4 fixtures README Transcripts section (R0.7)
- Executor sd-executor-contract, commit b7089c2: "## Transcripts" in packages/contract/fixtures/README.md (sources by session id, selection reasons, gaps, scrub rules, row-type coverage table counted over the scrubbed output, regenerate commands); per-fixture README generator now lists rows per file plus total (scripts/lib/transcript-scrub-{readme,run}.mjs, 3 new assertions).
- Results: scripts 409 pass, 2 skipped; contract 1091 pass; typecheck, lint, prettier clean. Regenerated twice, tree hash de4e0b10b9760ed3 both times (only READMEs changed). Leak check 0 findings, exit 0.

### U5 security gate round 1 (R0.7)
- sd-security-reviewer on 2426e6d..b85e3b9 plus the untracked transcripts: Gate fail. 3 HIGH (private config file contents kept as 120-char prefixes, including a health term from the user's global instructions; an identity word list from an earlier review session's grep survived; MCP instruction blocks kept as free text, exposing the university and private infrastructure), 4 MEDIUM (private repo names, hook additional context not dropped, leak checker passable since free text was only length-checked, an absolute path in this log), 3 LOW (secret shapes, id pattern, custom agent names).
- Orchestrator fixed the absolute path in this log (line 8).
- Fix round 1, sd-executor-contract, commit 2e95669: contents next to paths outside the project dropped to `<BLOB n>` (and outputs of tool uses that touched them); local gitignored deny-list packages/contract/fixtures/raw/deny-words.txt read by scrub and leak check; handle substrings of 5+ chars swept; addedBlocks, addedLines, skill_listing, hook_additional_context and hook stdout dropped; MCP and private repo names mapped; new secret shapes; id pattern narrowed; custom agent names mapped; this log and the inventory research note added to the text checks. Scripts 444 pass, 2 skipped; contract 1091; typecheck, lint, prettier clean; tree hash a698496f2d443787 twice; leak check 0 findings with 10 deny words.

Decision (orchestrator): no salted hashes of deny words are committed (the reviewer's suggestion). Short dictionary words with a public salt can be confirmed by guessing, which is a leak in a public repo. CI relies on structural checks that need no secrets; the deny-list check runs locally whenever raw/ exists, as the S0b literal check does.
