# Patches

## S0b-claude-dir.patch

Claude Code refused headless edits under `.claude/` in session S0b, so the conductor decision 4 and 5 changes are carried as a patch. It changes:

- `.claude/hooks/guard.mjs`: blocks `node`, `node.exe` or `npx` running the `capture-install` script with `--apply` (plain, quoted, quoted paths with spaces, backslash paths, either flag order, env or `VAR=` prefixes, `pnpm exec`, `time`, `if`/`then`, braces, `node -r x`, `cmd /c`, `powershell -c`, `$(...)`, backticks, line continuations, a trailing redirect). It prevents accidents by a well-behaved session; it is not a defence against a hostile one. Renamed copies, variables, split quoting, globs and encoded commands get past it (listed as known gaps in the tests), and a compromised session already has the user's privileges. Previews without `--apply`, `--apply-later`, and commands that mention the flag without a leading `node` (grep, git log, commit messages) stay allowed. Known false positives (fail closed, listed in the tests): any command that contains `node <capture-install> ... --apply`, quoted or not, is blocked. That includes a grep pattern, a commit message and an unquoted `echo node scripts/capture-install.mjs --apply`. The rule is also linear-time (one anchor character, no repeated whitespace) and only runs when the command contains both `capture-install` and `--apply`, so long whitespace runs cannot push the hook past its 5 s timeout; the tests time the whole guard on adversarial inputs (under 200 ms each).
- `.claude/settings.json`: two `Read(...)` deny entries for the default capture directory under local app data (best effort: Bash reads, a non-default `LOCALAPPDATA` and `SESSIONDECK_CAPTURE_HOME` are not covered).
- `.claude/skills/fixture-capture/SKILL.md`: raw files land in `%LOCALAPPDATA%/sessiondeck/capture/raw/<event>/...`, copied to `packages/contract/fixtures/raw/` by `scripts/UNINSTALL.txt` step 5; install step says to run `--apply` yourself.
- `scripts/lib/settings-files.mjs`: one comment updated to describe the guard rule.
- `scripts/test/guard.test.ts` (new): tests for the guard rule (blocked, allowed, known gaps) and the deny array.

Apply in `<S0b worktree>` (branch `p0/fixtures`), or after the conductor merges this branch, in a checkout of `sprint/0-bootstrap`. Never apply or commit on `main`: the user's main checkout has no `docs/patches/`. Run it in a plain terminal:

```
git apply docs/patches/S0b-claude-dir.patch
```

Then `pnpm -F @sessiondeck/scripts test` and commit the five files.

## FIX-2-guard.patch

Fixes the quadratic matching in `.claude/hooks/guard.mjs` that the security review of FIX-2 found (HIGH). Claude Code treats a PreToolUse hook timeout (5 s) as allow, so a command that makes the guard run longer than that gets through. The exploit: a prompt injection makes a session emit about 16k copies of `git push `, then `;`, then a forbidden push. For every `git push` start the three push rules ran `[^|;&]*` to the end of the segment and backtracked, so the time grew with the square of the input (measured before the fix: 72k characters 2.5 s, 144k characters 8.5 s and exit 0). This patch supersedes the "linear-time" claim in the S0b section above, which was false for inputs that repeat a rule's anchor; the guard header now states the argument.

It changes exactly two files:

- `.claude/hooks/guard.mjs`:
  - Push rules (all three): the match must start at the beginning of the command or after `| ; &`, and a lookahead finds the first `git push` of that segment once (a lookahead is atomic in JS, so later occurrences are never retried). The tail pattern is unchanged. Each segment is scanned by one start. Later occurrences cannot change a verdict: if one had the flag or main after it, the first has it too.
  - capture-install `--apply`: the node anchor is a lookahead shape (`node`, at most 32 options, the script), so the match is the node part only. The `--apply` check runs once for that candidate, from its end to the end of its segment, instead of in a lookahead at every anchor. If the flag is missing, matching resumes after that segment. The unquoted path prefix no longer allows `{` (a run of `{` made each start rescan the run; `{` is itself an anchor, so verdicts stay the same).
  - `rm -rf` rule: the flag token class is split (letters before the first `r`, or before the first `f`, exclude that letter) so `rm -rrrr...` is no longer quadratic. Found while proving the fix: `rm -` plus 100k `r` took 6.3 s.
  - The header comment states the linearity argument rule by rule.
- `scripts/test/guard.test.ts`: 12 new rows in the `timingInputs` table (about 100k characters each), the three existing blocked capture-install rows now expect 9 regex calls instead of 8 (the rule makes one more regex call), and the call-count comment explains each count.

Behaviour changes: more than 32 options between `node` and the capture-install script is no longer recognised (a well-behaved session does not do this). A differential run of 3000 random fragment commands (1285 blocked by the old guard) gave identical exit codes with the old and new guard, and all functional tests (75 in `scripts/test/guard-rules.test.ts`, plus `guard.test.ts`) pass unchanged.

Evidence (temporary detached worktree on cc4302a with offline install, removed afterwards):

- RED, original guard, new rows, regex matching time against the 150 ms bound: `git push ` x 11000 (99k) 3040 ms; `git push -` x 10000 (100k) 2689 ms; `git push origin ` x 6250 plus `main` (100k) 1359 ms; `node ` x 20000 plus `--apply capture-install` (100k) 1424 ms; `echo capture-install --apply; ` plus `node -x ` x 12500 (100k) 1350 ms; `rm -` plus 100k `r`, and 100k `{` plus ` capture-install --apply`, were killed at the 4000 ms wall limit. The `git branch `, `git reset ` and `rm -rf ` runs (0.6 to 0.9 ms) are regression guards that pass on both guards. `node scripts/capture-install.mjs ` x 3000 plus `--apply` (1.3 ms) fails only on the call count. 8 of the 11 rows then present failed.
- GREEN, patched guard: `pnpm -F @sessiondeck/scripts test` three times, each 567 passed and 3 skipped (the existing skips), about 24 s; `pnpm -r test` once, contract 1091 passed and scripts 567 passed; typecheck, `pnpm lint`, `eslint .` and `prettier --check .` clean. Every new row matches in 1 to 6 ms (the `node -x ` x 12500 row 23 ms), well under the 150 ms bound.

Apply in a plain terminal, in a checkout of `sprint/0-bootstrap` (never `main`; the user's main checkout has no `docs/patches/`):

```
git apply docs/patches/FIX-2-guard.patch
pnpm -F @sessiondeck/scripts test
git add .claude/hooks/guard.mjs scripts/test/guard.test.ts
git commit -m "fix(sprint-0): guard repeated-anchor matching is linear, with timing rows"
```
