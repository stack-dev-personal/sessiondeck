# Prompt book

Every prompt that starts a sessiondeck session, by level. Copy the block, fill the `{PLACEHOLDERS}`, paste. The levels nest: the conductor (`CONDUCTOR.md`) launches mini-sprint orchestrators (`MINI-SPRINT-ORDER.md`); each mini-sprint orchestrator launches phase-manager sessions with the prompt in section 2; phase managers delegate to the `sd-executor-*`, `sd-reviewer`, `sd-security-reviewer`, `sd-verifier` subagents.

| Level | Runs where | Agent | Prompt |
|-------|------------|-------|--------|
| 0 Conductor | your laptop, PowerShell, interactive | `sd-conductor` | `CONDUCTOR.md` |
| 1 Mini-sprint orchestrator | one Docker container per sprint, headless (`claude -p`) | `sd-sprint-orchestrator` | section 3 here, filled per sprint in `MINI-SPRINT-ORDER.md` |
| 2 Phase manager | a git worktree inside the sprint container, headless | `sd-orchestrator` | section 2 here, wrapping one `docs/handoffs/S*.md` |
| 3 Workers | subagents of a phase manager | `sd-executor-*`, reviewers, verifier | delegation template in `.claude/skills/work-unit/SKILL.md` |

Headless sessions cannot ask you anything. Every prompt below therefore ends with the same rule: a question becomes a `blocked` status plus a `questions.md`, and the session exits; the conductor asks you and relaunches with the answer (section 5).

## 1. Universal preamble

Prepended to every level-1 and level-2 prompt. It is the only place the reading order is defined, so the handoff files stay short.

```
Context, in this order, before any action:
1. CLAUDE.md (operating model, guided loops, permissions, conventions)
2. docs/planning/00-open-decisions.md (assumptions you must not silently change)
3. docs/planning/04-session-map.md section 1 (operating model) and section 2 (branch and parallelism table)
4. The documents your handoff names, in its order
5. docs/decisions/README.md (accepted ADRs; a conflict with one is a stop condition)

Sprint context:
- Sprint: {SPRINT_ID} ({SPRINT_NAME}); joined branch: sprint/{SPRINT_ID}-{SPRINT_SLUG}
- State directory: /state/{SPRINT_ID}/ (bind-mounted; the conductor reads it). Write status there per PROMPT-BOOK.md section 6.
- Contract commit: {CONTRACT_SHA} (after Sprint 0; "n/a" during Sprint 0)
- Concurrency allowed for this process: {MAX_PARALLEL}

You are headless. Nobody will answer a question in this session. If you need the user, follow PROMPT-BOOK.md section 5 (write questions.md, set status blocked, exit 0).
```

## 2. Phase-manager session prompt (level 2)

One per `docs/handoffs/S*.md`. The mini-sprint orchestrator runs it as:

```
git worktree add /work/wt/{SESSION_ID} -b {SESSION_BRANCH} sprint/{SPRINT_ID}-{SPRINT_SLUG}
cd /work/wt/{SESSION_ID}
claude -p "$(cat /state/{SPRINT_ID}/prompts/{SESSION_ID}.md)" \
  --agent sd-orchestrator --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  | tee /state/{SPRINT_ID}/logs/{SESSION_ID}.jsonl
```

(`--dangerously-skip-permissions` only inside the container; the project `.claude/settings.json` deny rules and `guard.mjs` still apply.)

The prompt file `/state/{SPRINT_ID}/prompts/{SESSION_ID}.md` is:

```
{UNIVERSAL PREAMBLE}

You are the phase manager for session {SESSION_ID} of sessiondeck, running inside mini-sprint {SPRINT_ID}.
Handoff: docs/handoffs/{HANDOFF_FILE} (read it now; it names the phase doc, the goal, the requirement IDs, the executors and reviewers, and the stop conditions).
Branch: {SESSION_BRANCH}, created from sprint/{SPRINT_ID}-{SPRINT_SLUG}. Push only this branch.

How to develop
- Keep every subagent call in the foreground. Never start an Agent call in the background: a headless main turn that idles stops background subagents and the session exits.
- Run /sprint-loop. Delegate with the /work-unit template. Executors own directories (.claude/agents/README.md); a unit that needs another directory becomes a task for that directory's executor.
- Tests before or alongside code, per /work-unit. No unit is reported done without its proving test or bench.
- Test containers: you are expected to use Docker for anything with a runtime. `docker compose -f infra/docker-compose.yml up -d` for the hub when your unit touches ingest, API, or WS; a throwaway Postgres or Supabase container when the unit touches storage; a Playwright container (`mcr.microsoft.com/playwright`) for web. Executors may start and stop containers freely; name them `sd-{SPRINT_ID}-{SESSION_ID}-*` and remove them at session end.
- Automate the user's testing: for every requirement that a human would otherwise check by looking (board renders, card states, drawer, layouts, content view), write a Playwright flow under packages/web/e2e/ that performs the user's steps and saves screenshots to /state/{SPRINT_ID}/screens/{SESSION_ID}/<requirement>.png. The conductor shows these to the user instead of asking them to click through. Same idea for the probe and hub: harness scripts that print the evidence a user would otherwise gather by hand.
- Windows-only behavior (probe, runner) cannot be exercised in this Linux container. Write the test so the windows-latest CI job runs it, mark the requirement "verified by CI" in the VERIFY table, and list it under "needs laptop confirmation" in your final report.

Reviewer order, every unit, no exceptions
1. sd-reviewer on the unit's diff (base: sprint branch, head: your branch).
2. sd-security-reviewer, in parallel with 1, when the handoff names it or the unit touches: settings merge, tokens, ingest, auth, redaction, infra, runner, fixtures.
3. Fixes go back to the same executor with the findings verbatim (/review-loop). Maximum three iterations, then stop with status blocked and the findings in questions.md.
4. sd-verifier on the unit's requirement IDs. Partial is fail.
5. At session end: full `pnpm -r test`, `pnpm -r typecheck`, `pnpm -r lint`; the integration checks listed for your session in MINI-SPRINT-ORDER.md; then sd-verifier once more over every ID in the handoff, writing docs/VERIFY-P{PHASE}.md.

Merging methodology
- Commit small, on your branch, messages naming requirement IDs.
- Before you finish: `git fetch origin && git rebase origin/sprint/{SPRINT_ID}-{SPRINT_SLUG}`. Resolve conflicts through an executor, re-run the full suite after any conflict.
- Push the branch and open a PR whose base is sprint/{SPRINT_ID}-{SPRINT_SLUG} (never main), using .github/PULL_REQUEST_TEMPLATE.md. Fill every section; the reviewer verdict and verifier table are pasted in, not described.
- You do not merge. The mini-sprint orchestrator merges green session branches into the sprint branch in the order MINI-SPRINT-ORDER.md gives.

Status (PROMPT-BOOK.md section 6)
- Write /state/{SPRINT_ID}/sessions/{SESSION_ID}.json at intake, after every unit, and at exit. States: running, blocked, green, failed.
- While a unit runs, rewrite that file at least every 15 minutes (updated_at, current_unit) so the conductor can tell a live session from a dead one.
- green means: PR open against the sprint branch, CI green on the branch, VERIFY table has every handoff requirement at pass or "verified by CI", reviewer verdict merge, security gate pass where required.
- Session log: docs/sessions/{SESSION_BRANCH_SLUG}.md on your branch, per /sprint-loop.

Exit
- Final message = the report format in .claude/agents/sd-orchestrator.md (PR URL, DoD checklist with evidence, open questions, what the user must do). Also write it to /state/{SPRINT_ID}/reports/{SESSION_ID}.md.
- Exit 0 in every case; the status file carries the outcome.
```

Placeholders: `SESSION_ID` (S1, S9b), `HANDOFF_FILE` (S01-probe-hook-and-statusline.md), `SESSION_BRANCH` (p1/probe-hook), `PHASE` (1), `SESSION_BRANCH_SLUG` (p1-probe-hook).

## 3. Mini-sprint orchestrator prompt (level 1)

One per sprint; the filled versions are in `MINI-SPRINT-ORDER.md`. The conductor runs it as (see `infra/sprint/README.md` for the container):

```
scripts/sprint/run-sprint.ps1 -Sprint {SPRINT_ID}
# inside the container, entrypoint runs:
claude -p "$(cat /state/{SPRINT_ID}/sprint-prompt.md)" --agent sd-sprint-orchestrator \
  --dangerously-skip-permissions --output-format stream-json --verbose \
  | tee /state/{SPRINT_ID}/logs/sprint.jsonl
```

Template:

```
{UNIVERSAL PREAMBLE}

You are the mini-sprint orchestrator for sprint {SPRINT_ID} ({SPRINT_NAME}) of sessiondeck. You run until every session in this sprint is green and the joined branch is ready to merge, or until you are blocked. You write no code and resolve no conflicts yourself; you launch, monitor, relaunch, merge, and report.

Keep every subagent call in the foreground. Never start an Agent call in the background: a headless main turn that idles stops background subagents and the session exits.

Package (from MINI-SPRINT-ORDER.md, sprint {SPRINT_ID}):
- Sessions and lanes: {SESSION_TABLE}
- Merge order into the sprint branch: {MERGE_ORDER}
- Integration gate: {INTEGRATION_CHECKS}
- User gates before start: {USER_GATES}
- Max parallel phase managers: {MAX_PARALLEL}

Setup
1. /work is a fresh clone. `git fetch origin && git checkout -B sprint/{SPRINT_ID}-{SPRINT_SLUG} origin/main` (or `origin/sprint/{SPRINT_ID}-{SPRINT_SLUG}` if it exists: this is a relaunch). Push the sprint branch.
2. Write /state/{SPRINT_ID}/status.json with state running and the session table (section 6).
3. For each session, write its level-2 prompt from PROMPT-BOOK.md section 2 to /state/{SPRINT_ID}/prompts/{SESSION_ID}.md, with the universal preamble filled.

Launch and monitor
4. Start every session whose dependencies (within this sprint) are green, up to {MAX_PARALLEL} at once, each in its own worktree, as a background process with the exact command in PROMPT-BOOK.md section 2. Record pid and start time in status.json.
5. Poll /state/{SPRINT_ID}/sessions/*.json every 60 seconds (a bounded `sleep 60` loop, max 20 minutes per Bash call, then re-read state and loop again). On each poll update status.json and append one line to /state/{SPRINT_ID}/sprint-log.md: time, session, state, last unit.
6. Session blocked: copy its questions.md into status.json under questions, set the sprint state to blocked if nothing else can run, and keep polling. When /state/{SPRINT_ID}/answers/{SESSION_ID}.md appears (the conductor wrote it), relaunch that session with the resume prompt (section 5) in the same worktree.
7. Session failed (process exited without a green or blocked status, or CI red after two pushes): relaunch once with the resume prompt and `Reason: previous run ended without status; read docs/HANDOFF-*.md if present and continue`. A second failure marks the session failed in status.json and continues with the rest; the conductor decides.
8. When a session reaches green, start whatever it unblocked.

Merge
9. All sessions green: merge in the given order. For each: `git checkout sprint/... && git merge --no-ff {SESSION_BRANCH}`. On conflict: do not resolve by hand. Launch a conflict-resolution session (section 7) for that branch, wait for green, merge again.
10. After the last merge, run the integration gate on the sprint branch inside this container, with test containers as needed (`docker compose -f infra/docker-compose.yml up -d`, Playwright user flows from every session, full `pnpm -r test`). Save outputs and screenshots under /state/{SPRINT_ID}/gate/. A failed gate becomes a fix session (section 7) on the sprint branch, then re-run the gate.
11. Gate green: push the sprint branch, open a PR sprint/{SPRINT_ID}-{SPRINT_SLUG} → main with: the sprint summary, every session's PR link, the VERIFY tables, gate results, screenshot list, "needs laptop confirmation" items, and the exact merge command the conductor will run. Set status awaiting-merge-approval. Do not merge to main; you are not allowed to and the guard blocks it.

Exit
12. Write /state/{SPRINT_ID}/reports/sprint.md (what merged, what is pending on the user, what the next sprint needs). Exit 0.

Never: push to main, force-push, delete branches, resolve conflicts by editing, run anything outside this container, or start a session whose user gate is unmet.
```

## 4. Conductor prompt (level 0)

Lives in `CONDUCTOR.md` in full. Start it on the laptop with:

```
cd $env:USERPROFILE\projects\sessiondeck
claude --agent sd-conductor
```

then paste the contents of `CONDUCTOR.md`.

## 5. Question and resume protocol

Writing a question (any headless level):

```
/state/{SPRINT_ID}/questions/{SESSION_ID}.md   (or sprint.md for the orchestrator)
# Question from {SESSION_ID} {timestamp}
Context: <two lines: unit, requirement IDs>
Question: <one question>
Options: <A ...> <B ...> <C ...>   (recommended first, say why in one line)
Default if no answer within 24h: <letter or "none, stay blocked">
Impact: <what cannot proceed>
```

Then set status `blocked` with `question_file` set, commit the work so far on the branch (WIP commit is fine, name it `wip: blocked on <topic>`), and exit 0.

Resume prompt (the orchestrator relaunches with this, same worktree, same branch):

```
{UNIVERSAL PREAMBLE}

Resume session {SESSION_ID}. You were blocked. The user's answer is in /state/{SPRINT_ID}/answers/{SESSION_ID}.md; read it first, record it under "Decisions made" in your session log, then continue /sprint-loop from the task list in docs/sessions/{SESSION_BRANCH_SLUG}.md (or docs/HANDOFF-*.md if you wrote one). Everything in the original prompt still applies:

{ORIGINAL LEVEL-2 PROMPT BODY}
```

## 6. Status files (what the conductor reads)

`/state/{SPRINT_ID}/status.json`

```json
{
  "sprint": "1", "name": "mvp", "branch": "sprint/1-mvp",
  "state": "running | blocked | merging | gate | awaiting-merge-approval | merged | failed | green",
  "started_at": "2026-10-12T01:00:00Z", "updated_at": "...",
  "sessions": {
    "S1": { "state": "green", "branch": "p1/probe-hook", "pr": 4, "verify": "docs/VERIFY-P1.md", "units_done": 5, "units_total": 5, "updated_at": "..." },
    "S2": { "state": "blocked", "question_file": "questions/S2.md", "updated_at": "..." }
  },
  "questions": ["questions/S2.md"],
  "pr": null,
  "gate": { "state": "pending | pass | fail", "report": "gate/README.md" },
  "needs_laptop_confirmation": ["R1.1 hook p95 on Windows"]
}
```

Sprint state `green` means the sprint's sessions and its gate are done and no PR step is pending. The smoke sprint writes it (`/state/smoke/status.json`, prompt in `scripts/sprint/render-prompt.mjs`); `scripts/sprint/status.ps1` and `smoke-check.ps1` accept it. A sprint that goes on to open a PR uses `awaiting-merge-approval` instead.

`/state/{SPRINT_ID}/sessions/{SESSION_ID}.json` is the same shape as one `sessions` entry plus `current_unit`, `last_report`, `pid`.

Both are written atomically (tmp + rename) and never contain secrets.

## 7. Conflict-resolution and gate-fix session prompt

Launched by the orchestrator on the sprint branch when a merge conflicts or the integration gate fails. Same mechanics as a level-2 session; branch `sprint/{SPRINT_ID}-{SPRINT_SLUG}` directly.

```
{UNIVERSAL PREAMBLE}

You are a fix session on sprint/{SPRINT_ID}-{SPRINT_SLUG}. Scope: {"merge conflict between <branch> and the sprint branch" | "integration gate failure: <check>"}. Evidence: /state/{SPRINT_ID}/gate/ or the conflict markers in the listed files.

Rules: delegate every edit to the executor that owns the directory; the resolution must keep both sides' requirement IDs passing (run both sessions' tests); no feature work; no scope changes. Review with sd-reviewer (and sd-security-reviewer if the conflict touches a gated area); verify the affected IDs with sd-verifier. Commit with message `fix(sprint-{SPRINT_ID}): <scope>`. Status file: /state/{SPRINT_ID}/sessions/FIX-{n}.json. Green = conflict resolved or gate passing with evidence under /state/{SPRINT_ID}/gate/. Exit 0.
```

## 8. Integration gate (run by the orchestrator on the joined branch)

Always:
- `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
- CI green on the pushed sprint branch (`gh run list --branch sprint/... --limit 1`)
- Every VERIFY-P*.md touched in this sprint has no `fail` rows

Plus the sprint-specific checks in `MINI-SPRINT-ORDER.md` (hub compose smoke, Playwright user flows, load harness, redaction corpus, migration dry run). All outputs under `/state/{SPRINT_ID}/gate/` with a `README.md` index the conductor can show you.
