# Session log: p0/scaffold (S0)

- Date: 2026-10-08 (local), started 2026-10-09T03:03:21Z
- Handoff: docs/handoffs/S00-contract-and-scaffold.md
- Sprint: 0 (bootstrap), base branch sprint/0-bootstrap at 3e8178c
- Contract SHA: n/a (this session creates the contract)
- Mode: headless phase manager, local laptop (Windows 11), worktree C:/Users/stack/projects/wt/S0

## Intake facts

- Claude Code 2.1.295 (A5 needs 2.1.251 or later: holds)
- Node v24.19.0 locally (phase doc names Node 22; CI pins 22, engines allow 22 and later)
- pnpm absent at intake; installed in U1
- Git Bash present (A2 holds), Docker 29.8.1, gh 2.101.0 authenticated as emstacho-su
- Vault copy of the planning set: C:/Users/stack/vault/projects/sessiondeck

## Task list

| Unit | Scope | Requirements | Executor | Security gated | Blocked by | Status |
|------|-------|--------------|----------|----------------|------------|--------|
| U0 | License and borrow-source research (network) | borrow map check | researcher (general-purpose) | no | none | in progress |
| U1 | Monorepo scaffold, CI workflow, ENVIRONMENT.md | R0.5, R0.6 | sd-executor-contract | no | none | in progress |
| U2a | contract: envelope, snapshot, transcript types, statusLine schema | R0.1, R0.4 | sd-executor-contract | no | U0, U1 | pending |
| U2b | contract: state reducer, transition table, docs/CONTRACT.md | R0.2, R0.3 | sd-executor-contract | no | U2a | pending |
| U3 | scripts: capture-fixtures, capture-install, settings merge tests | R0.7 (tooling share) | sd-executor-contract | yes | U0, U1 | pending |

Out of this session by plan: R0.8 (S0c), the captured fixture set and golden timeline of R0.7 and R0.2 (S0b, after the capture day).

## Decisions made

1. Package shells for probe, hub, web are not created here. Those directories belong to other executors (.claude/agents/README.md) and sd-executor-contract is told not to edit them. The workspace glob packages/* picks each package up when S1, S3, S5 create it. Deviation from the phase doc Scope line "empty shells"; no R0.x depends on it.
2. The handoff says .claude/agents is populated from docs/agents. docs/agents does not exist and .claude/agents already holds twelve sd-* agents (the nine in R0.6 plus sd-researcher, sd-conductor, sd-sprint-orchestrator). Nothing to copy; R0.6 is checked as "contains the nine".
3. Unit tests may use synthetic inputs built inline in test files for documented payload fields. The fixtures directory is reserved for captured data, with one labeled exception: fixtures/settings/with-harness-hooks.json, the synthetic settings file the merge test needs (fixture-capture skill).
4. Commit messages: conventional prefix plus imperative subject under 72 chars, body names requirement IDs. No attribution trailers (user git-workflow rule).
5. sd-researcher is not offered as an agent type in this session; a general-purpose agent does the network lookups and saves sources under .sprint/0/research/S0/ for executors to read.

## Units

## Deferred findings

## Open questions

### U0 research (done)
- Licenses: 6 of 6 MATCH the borrow map (ccstatusline, ccmon, cctop, ccmonitor, agents-observe, Claude-Code-Usage-Monitor, all MIT). ccmonitor LICENSE was added upstream on 2026-02-17 (commit 64a9a4a), which explains the note "clone lacked it". Crystal checked separately: MIT, "Copyright (c) 2024 Stravu", HEAD 1e18e0b. GitHub reports stravu/crystal as not archived (borrow map says archived Feb 2026; not a license matter).
- Sources and official doc pages saved under .sprint/0/research/S0/ (sources/, docs/). FINDINGS.md was not written by the researcher (harness blocked it); the facts were passed inline to executors.
- Official docs list 33 hook events; all 17 planned ones are documented. Exec form (`command` + `args`) is documented. `statusLine` and `subagentStatusLine` are shell strings only (no exec form).

### U1 scaffold and CI (R0.5, R0.6)
- Commits 764fcf7, 9ea5a43, fa3784c; fixes 1ebff5b, 17fc8f9, b66f15e, c6189b5.
- sd-reviewer iteration 1: fix-then-merge, 1 MAJOR (root .prettierignore dead for package lint) and 8 MINOR. All nine fixed. Re-review pending.
- CI run 37878703574 green on ubuntu-latest and windows-latest at fa3784c.
- pnpm 12.10.1 installed globally with npm; versions in docs/ENVIRONMENT.md.

### U2a contract schemas (R0.1, R0.4)
- Commits 1497682, 45b53e5; fixes b5de96e, 136bc0c.
- sd-reviewer iteration 1: fix-then-merge, 2 MAJOR (fixture walk could stay skipped under another layout; Crystal types without borrow header) and 10 MINOR. Eleven fixed, one deferred (below). Re-review pending.

### U3 capture tooling (R0.7 tooling share), security gated
- Commits e2471af, 15cf12f, 382fa4c. 85 tests.
- sd-security-reviewer iteration 1: Gate fail. 1 HIGH (uninstall recognizes entries only by exact script path; a mismatch is a silent no-op that deletes the restore state), 3 MEDIUM (hook is live code in a mutable worktree; one ignore rule is the only thing keeping raw captures out of git; no interlock against a bare run on the real settings), 9 LOW. Fix iteration 1 in progress.
- sd-reviewer: pending (runs on the post-fix head).

### U2b reducer and CONTRACT.md (R0.2, R0.3)
- Commits 85c6757, 88a90a9, e859bd3. 125 passed, 10 skipped (TODO(fixture)). Review pending.

## Decisions made (continued)

6. Envelope: `hook_event_name` is required when kind is `hook`; `session_id` must be non-empty and is null only for kind `probe`; a missing or undefined `payload` is rejected, `payload: null` is accepted.
7. Snapshot time units: `Window.resets_at` and `prompt_cache.expires_at` are epoch ms (statusLine payload sends epoch seconds). A rate-limit `used_percentage` outside 0..100 becomes null (no clamp).
8. Fixture layout: raw captures in packages/contract/fixtures/raw/<Event>/ (gitignored, never loaded by tests); scrubbed committed fixtures in packages/contract/fixtures/<Event>/*.json, plus statusLine/ and subagentStatusLine/; fixtures/settings/ is merge-test input. A non-skipped test fails on any other layout. S0b must follow this.
9. Pid transport: the Envelope interface of architecture 3.1 is unchanged. The pid travels in `liveness` payloads `{ pid, alive }`; `alive: true` reports the pid, `alive: false` moves a live session to `exited`. Same-pid supersede is a pure function over a snapshot collection. Marked "decided in S0, confirm in S1" in docs/CONTRACT.md. Open question for the user (below).
10. Capture uninstall is surgical (removes only our entries, restores the status line from recorded state) instead of restoring the whole backup, so settings the user changed during the capture day survive. The backup stays for manual recovery.
11. CI matrix runs Node 22 and 24 (laptop runs 24.19.0).
12. Not changed by this session, on purpose: .claude/hooks/guard.mjs and .claude/settings.json. The security reviewer recommends a guard rule for capture-install and a Read deny for fixtures/raw; both are project controls for the user to change.

## Deferred findings

- packages/contract/src/wire.ts:7 (sd-reviewer, MINOR): the ingest schema is all-or-nothing and does not tie body `host` to each envelope's `host`. One bad envelope fails a 200-envelope batch; under R2.1 that is a 400 and a daemon with a persisted cursor could retry forever (R1.5). Matches architecture 3.4 as written. Needs a decision in S3 (hub ingest) and S2 (daemon retry): host-equality refine, and whether a 400 means drop or retry.

## Open questions

1. Pid transport (decision 9): keep `liveness { pid, alive }` or add an optional `pid` to the envelope? Affects S1 (probe hook) and S3 (hub).
2. origin points at github.com/emstacho-su/sessiondeck, which GitHub redirects to stack-dev-personal/sessiondeck (private). PR links use the second name.
