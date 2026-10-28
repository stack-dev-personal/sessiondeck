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
- sd-security-reviewer on 2426e6d..b85e3b9 plus the untracked transcripts: Gate fail. 3 HIGH (private config file contents kept as 120-char prefixes; an identity word list from an earlier review session's grep survived; MCP instruction blocks kept as free text, exposing affiliation and private infrastructure), 4 MEDIUM (private repo names, hook additional context not dropped, leak checker passable since free text was only length-checked, an absolute path in this log), 3 LOW (secret shapes, id pattern, custom agent names).
- Orchestrator fixed the absolute path in this log (line 8).
- Fix round 1, sd-executor-contract, commit 2e95669: contents next to paths outside the project dropped to `<BLOB n>` (and outputs of tool uses that touched them); local gitignored deny-list packages/contract/fixtures/raw/deny-words.txt read by scrub and leak check; handle substrings of 5+ chars swept; addedBlocks, addedLines, skill_listing, hook_additional_context and hook stdout dropped; MCP and private repo names mapped; new secret shapes; id pattern narrowed; custom agent names mapped; this log and the inventory research note added to the text checks. Scripts 444 pass, 2 skipped; contract 1091; typecheck, lint, prettier clean; tree hash a698496f2d443787 twice; leak check 0 findings with 10 deny words.

Decision (orchestrator): no salted hashes of deny words are committed (the reviewer's suggestion). Short dictionary words with a public salt can be confirmed by guessing, which is a leak in a public repo. CI relies on structural checks that need no secrets; the deny-list check runs locally whenever raw/ exists, as the S0b literal check does.

### U5 security gate round 2 (R0.7)
- Resumed 2026-10-28 after a 429 usage limit stopped the session on 2026-10-27 at 21:42Z. Fixtures were regenerated from the current scrub at cca96cb: tree hash a698496f2d443787 on both runs, matching fix round 1. Leak check: 259 files scanned, 0 transcript findings.
- sd-security-reviewer on 2426e6d..cca96cb plus the untracked transcripts: Gate pass, with 2 MEDIUM and 6 LOW. MEDIUM: private file contents still survive in the rendered[] and message-text copies of an attachment, and hook output survives outside attachment fields; the leak check did not catch either when they were planted. LOW: the fragment sweep leaves the rest of the word around a placeholder, which can reveal the removed piece; a user path with its separators lost slips through, and unmapped mcp__ names are not flagged; personal context remains in a few prompts; .sprint/ counts as inside the project; this log's round-1 wording (reworded); tracked docs outside this unit already publish the handle and the project names (owner decision).
- Decision (orchestrator): fix both MEDIUMs and the scrub LOWs in fix round 2 before committing the fixtures (the handoff says to cut more when in doubt), even though the gate passed.
- Fix round 2, sd-executor-contract, commit 5e2b433: the rendered[] copies of outside-path, hook and skill-listing attachments are dropped to `<BLOB n>`; "Contents of <outside path>:", hook labels, and "Result of calling" blocks after a private call are cut down to their label, in both the scrub and the leak check; the account sweep now replaces whole words, and account literals are validated by shape; glued `C:Users...` paths are scrubbed and flagged; unmapped mcp__ names are flagged; .sprint/ counts as outside the project. 4 phrases added to the local deny-list (time zone, travel); the hardware mention was accepted (already public in docs). Scripts 467 pass, 2 skipped. Tree hash ed2a2705261ccdc5 on both runs; leak check 0 findings.
- sd-reviewer on 2426e6d..5e2b433: Verdict changes. 3 MAJOR: the git literal lookup failed open; `<PROJECT_A>` was the alphabetically first project folder, not this repo; the README rules were stale. 2 MINOR: no run-level test for an unknown key; the inventory test spawned node in the default suite.
- Fix, sd-executor-contract, commit 0cf61fa: the scrub exits 1 when a git lookup comes back empty (the leak check does the same only when raw/ exists; `--no-git-literals` opts out of both); the repo's own folder is seeded as `<PROJECT_A>` (with `--own-project` to override) and the run fails on a mismatch. This was a real catch: in fixtures 01 and 05, `<PROJECT_A>` had been the worktree parent folder. README updated; unknown-key exit test added; the inventory test moved to test:proc. Scripts 472 pass and proc 271 pass. Tree hash 45d66215072d7905 on both runs.
- sd-reviewer on 5e2b433..0cf61fa: Verdict merge, 4 MINOR. All 4 fixed in commit 70f6249: raw/, .env* and probe.json inside the repo now count as private; README wording; a git user.name that is set now counts as present; command-line wiring tests added. Scripts 497 pass and proc 273 pass; contract 1091 pass. Tree hash 1bf07a80cb695eca on both runs. Leak check exit 0, 0 findings (checked by the orchestrator).

### U5 security gate rounds 3 and 4, fixtures committed (R0.7)
- sd-security-reviewer round 3 on cca96cb..80689a0 plus the output (1bf07a80cb695eca): Gate pass, 2 MEDIUM, 4 LOW. The first attempt was cut off by a network error (ENOTFOUND) and was rerun. MEDIUM: zone names left in "session limit resets" lines; the private-path check missed relative, environment-variable home, ~/ and <ROOT> forms (no instance in the corpus). LOW: a heredoc into a private file kept about 40 characters of its content; README placeholder table out of date; travel context around deny words (owner's call, left as is); the check's "raw-derived" label (deferred).
- Fix, sd-executor-contract, commit d7a22f8: time zones become `<TZ>` (IANA names, abbreviations next to a time, offsets) and are a leak-check category; home-variable, ~/, <ROOT>, climbing and other .claude paths count as private; command text after a private write target is cut; README updated. Scripts 535 pass (2 skipped) and proc 273 pass; contract 1091 pass. The orchestrator regenerated twice: tree hash be80276627bfd436 both times (the executor had reported 98f37c2dbc49f472, which was not reproduced; the orchestrator's two fresh runs agree). Leak check exit 0, 0 findings.
- sd-security-reviewer round 4 (narrow) on 80689a0..d7a22f8 plus the output: Gate pass, 4 LOW, each with 0 instances in the real output. It confirmed the change only cuts more (rebuilt the old output, compared blob counts, every structural change is an object becoming a blob, same row counts).
- Fixtures committed after the gate passed: commit 9fd1c34, 44 files.

## Deferred findings (FX-T)
- LOW scripts/lib/transcript-scrub-cuts.mjs:33-50: only text after a private write target is cut; content before the target (echo "..." > private, here-string piped to Set-Content, >|, cp, dd of=) would keep a 120-char prefix and pass the check. 0 instances in the output.
- LOW scripts/lib/transcript-scrub-zone.mjs:13-20: git log `Date:` offsets, ISO offsets, legacy names (US/Eastern), bare abbreviations with no time, and city names are not covered. 0 instances in the output.
- LOW scripts/lib/transcript-scrub-private.mjs:67-68: the .claude segment test is case-sensitive (Windows is not). 0 instances.
- LOW packages/contract/fixtures/README.md:71-80: `<TZ>` is missing from the placeholder table.
- LOW scripts/fixture-leak-check.mjs:58: the check labels a run "raw-derived" even when no hook literals were derived.
- LOW 04-compaction/session.jsonl:1009: travel context around deny words; owner's call.
- LOW (carried from round 2): tracked docs outside this unit already publish the handle and the project names that the fixtures map to placeholders; owner decision.
- Commit cca96cb (in branch history) describes round 1's findings by category in wording later made generic at d45d645; the categories stay visible in history.

### PR and CI (R0.7, R0.5)
- sd-verifier: 18 pass / 0 fail / 0 unverifiable for R0.7 transcript rows, docs/VERIFY-P0.md, commit 1cacc6c. Its note: the 72 matches are a generic "Users" folder segment after placeholders, followed by `<DIR_n>`; no user name (the security reviewer saw the same). The verifier's row count (14528) differs from the leak check's (14545) by 17; not investigated.
- Pushed p0/transcript-fixtures and opened PR #16. CI push run 40728789393 failed on all four check jobs: transcript-leak.test.ts read the runner's git identity and remote, so its clean text matched account fragments. The duplicate pull_request run 40729255001 was cancelled to save minutes.
- Fix, sd-executor-contract, commit bd315a8: tests inject a synthetic git identity, origin and host (a new `host` seam, defaulting to os.hostname); production discovery unchanged. Reproduced locally under a foreign git identity, failing before the fix and passing after. sd-reviewer: Verdict merge, 2 MINOR, fixed in a0d1a92 (host stub in the remaining tests; a mutation-checked test that the host name is collected). Scripts 536 pass, 2 skipped; proc 273 pass. Fixtures unchanged (be80276627bfd436), leak check exit 0.
