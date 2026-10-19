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

Fixes the quadratic and exponential matching in `.claude/hooks/guard.mjs` that the security reviews of FIX-2 found (HIGH). Claude Code treats a PreToolUse hook timeout (5 s) as allow, so a command that makes the guard run longer than that gets through. The first exploit: a prompt injection makes a session emit about 16k copies of `git push `, then `;`, then a forbidden push. For every `git push` start the three push rules ran `[^|;&]*` to the end of the segment and backtracked, so the time grew with the square of the input (measured before the fix: 72k characters 2.5 s, 144k characters 8.5 s and exit 0). This patch supersedes the "linear-time" claim in the S0b section above, which was false for inputs that repeat a rule's anchor.

It changes five files (two of them new):

- `.claude/hooks/guard.mjs`:
  - Push rules (all three): the match must start at the beginning of the command or after `| ; &`, and a lookahead finds the first `git push` of that segment once (a lookahead is atomic in JS, so later occurrences are never retried). The tail pattern is unchanged. Each segment is scanned by one start. Later occurrences cannot change a verdict: if one had the flag or main after it, the first has it too.
  - capture-install `--apply`: the node anchor is a lookahead shape (`node`, at most 32 options, the script), so the match is the node part only. The `--apply` check runs once for that candidate, from its end to the end of its segment, instead of in a lookahead at every anchor. If the flag is missing, matching resumes after that segment. The unquoted path prefix no longer allows `{` (a run of `{` made each start rescan the run; `{` is itself an anchor, so verdicts stay the same).
  - Review round 1 fixes (both HIGH, plus one more of the same kind found while proving them): an option is `-[\w.-]+` (was `--?[\w.-]+`, where `--a` parsed as `--`+`a` or `-`+`-a`, so 33 options gave 2^33 paths); option values exclude a backslash that starts a backslash-newline (`-a x\<LF>` had two parses per option, 2^k, and the old guard has it too: 33 of them were killed at 20 s); the segment skip is `(?:\x5c\r?\n|[^|;&\n])*` (continuation first, like the flag scan, so a continued line is skipped in one pass instead of rescanned per candidate).
  - `rm -rf` rule: the flag token class is split (letters before the first `r`, or before the first `f`, exclude that letter) so `rm -rrrr...` is no longer quadratic. Found while proving the fix: `rm -` plus 100k `r` took 6.3 s.
  - The header comment states the argument rule by rule and names the test row for each claim.
- `scripts/test/guard.test.ts`: 18 new timing rows in the `timingInputs` table (about 100k characters each, plus the 244-character option shapes), the three existing blocked capture-install rows now expect 9 regex calls instead of 8, and the call-count comment explains each count. Each timing row passes on the first attempt that is within the bounds (at most 3); status and call-count mismatches fail on the first attempt.
- `scripts/test/guard-growth.test.ts` (NEW): seven growth rows, each shape run at about 100k characters and at 4x that (option shapes: k=16 and k=64). The ratio is computed on `matchMs` (regex time) with a 1 ms floor, not on `workMs`, which at 5 to 12 ms is mostly process noise (it jumped to 41 to 61 ms while `matchMs` stayed at 0.4 to 1.5 ms). It must stay under 8 (a quadratic gives 16); the 150 ms and 300 ms bounds apply to the 100k run only. A row passes on the first attempt within bounds (at most 3); a wall-timeout kill (`GuardKilledError`) counts as a violation and is retried, and is rethrown if all 3 attempts die. Includes the unit tests of the growth helper. Two rows put `node` anchors inside the 32-option window as option values (`node` plus backslash-LF ` -a ` backslash-LF ` node` x N, and `node` plus ` -a=yyyy/node` x N), the heaviest linear shapes.
- `scripts/test/helpers/guard-growth.ts` (NEW): `growthRatio`, `growthWithin` and `firstGrowthWithin` (the retry loop) used by the growth test.
- `scripts/test/guard-rules.test.ts`: three rows in `knownGaps` (expected ALLOWED), see below.

Behaviour changes and known gaps (all three rows are in `knownGaps`; two of the three rows would fail against the current guard, because `node capture-install "a;b" --apply` is allowed by both):

- More than 32 options between `node` and the capture-install script is no longer recognised (`node` plus 40 `-r x` plus `capture-install --apply` is allowed; the old guard blocked it). Accepted: a well-behaved session does not do this, and the rule is accident prevention, not a defence against a hostile session.
- The matcher is not quote aware. A `;` inside a quoted argument ends the segment for the flag check, so `node capture-install "x;)/node" capture-install --apply` was blocked by the old guard (by luck) and is allowed by the patch. `node capture-install "a;b" --apply` is allowed by both. These sit with the other quote-unaware cases already listed in `knownGaps` (split quoting, variables, globs, renamed copies).
- Differential run of old versus new guard: see Evidence. The only verdict differences are these two gap shapes.

Evidence (temporary detached worktree on 839604d with offline install, removed afterwards):

- RED, current guard (839604d), new round 1 rows, `workMs` or regex time against the 150 ms and 300 ms bounds: `node` plus `--a b` x33 plus `node scripts/capture-install.mjs --apply` (one segment, 243 chars) killed at the 4000 ms wall limit (20 s when run by hand); `node` plus `-a x` backslash-LF x33 plus the same tail killed at 4000 ms (20 s by hand); `echo --apply; ` plus `node capture-install \<LF>` x4500 (99k) 650 ms, CRLF 601 ms, growth 30 ms to 435 ms (ratio 14.3); the 40-option and `"x;)/node"` gap rows fail (current guard blocks them). `node` plus `--a b` x33 then `; node scripts/capture-install.mjs --apply` (cross segment, the first-patch exploit) takes 5 ms on the current guard and fails only on the call count (8, expected 9); the `--x=node` x7000 row likewise (8 vs 9). Against the previous version of this patch both of those, and the 33-option one-segment row, are killed at 4000 ms (20 s by hand), which is the regression the review found; the continuation rows are 675 ms and 579 ms there.
- RED from the first round (current guard, unchanged): `git push ` x 11000 (99k) 3040 ms; `git push -` x 10000 3460 ms; `git push origin ` x 6250 plus `main` 1357 ms; `node ` x 20000 plus `--apply capture-install` 1384 ms; `node -x ` x 12500 1660 ms; `rm -` plus 100k `r`, and 100k `{` plus ` capture-install --apply`, killed at 4000 ms.
- GREEN, patched guard (round 2, on 5da35f6, which runs the guard rule tests concurrently): `pnpm -F @sessiondeck/scripts test` three times, each 601 passed and 3 skipped (the existing skips), 20.7 to 23.2 s wall (guard.test.ts 18.0 to 20.0 s, guard-rules.test.ts 19.0 to 21.1 s, guard-growth.test.ts 5.1 to 7.5 s, in parallel workers; the unpatched suite on the same commit is 16.5 to 19.4 s; the previous patch version was 31 to 34 s, a Windows CI step budget of 60 s); `pnpm -r test` once, contract 1091 passed and scripts 601 passed, 27 s wall; typecheck, `pnpm lint`, `pnpm lint:root`, `prettier --check .` clean. Spawns in guard.test.ts: 17 without the patch (9 timing rows plus 8 self-test spawns), 35 with it (27 plus 8), every row passed on attempt 1; guard-growth.test.ts adds 14 (7 shapes, 2 runs each).
- Growth rows, patched guard (`matchMs` at N and 4N, ratio on `matchMs` with the 1 ms floor, attempts):

  | shape | N | 4N | ratio | attempts |
  |---|---|---|---|---|
  | `git push ` x N | 1.9 ms | 9.2 ms | 4.76 | 1 |
  | continuation, flag in another segment | 4.1 ms | 15.7 ms | 3.85 | 1 |
  | `--x=node` x N + `capture-install --apply` | 30.0 ms | 101.4 ms | 3.38 | 1 |
  | `node` + (backslash-LF ` -a ` backslash-LF ` node`) x N | 1.4 ms | 2.4 ms | 1.64 | 1 |
  | `node` + (` -a=yyyy/node`) x N | 1.1 ms | 4.1 ms | 3.72 | 1 |
  | options k=16 vs 64 | 1.0 ms | 1.3 ms | 1.24 | 1 |
  | backslash-value options k=16 vs 64 | 1.0 ms | 1.3 ms | 1.27 | 1 |

- RED of the two new node-anchor-as-option-value rows on the current guard: linear on both (0.4 to 0.6 ms with ratio 0.64, and 0.4 to 1.0 ms with ratio 0.96), so they are regression guards for the 32-option window, not reproductions. The other four growth shapes fail on the current guard (killed at the 4000 ms limit).
- Differential fuzz, old (839604d) versus patched guard: 6000 random fragment commands (two seeds of 3000, fragments include `--a`, `-a x` backslash-LF, `--x=node`, `"x;)/node"`, continuations, 2190 blocked by the old guard), 0 differing exit codes (a hang counts as a difference; there were none). The random fragments do not generate the two known-gap shapes, so the only intended differences are the two directed `knownGaps` rows (blocked by the old guard, allowed by the patch); there are no others.

Apply in the worktree `C:/Users/stack/projects/wt/FIX-1` (`sprint/0-bootstrap` is only checked out there; never `main`, whose checkout has no `docs/patches/`). The commands are the same in PowerShell and Git Bash. The patch touches five files, two of them NEW (`scripts/test/guard-growth.test.ts` and `scripts/test/helpers/guard-growth.ts`), so stage every file by path: never `git commit -a`, which skips new files.

```
cd C:/Users/stack/projects/wt/FIX-1
git branch --show-current
git status --short
git apply --check docs/patches/FIX-2-guard.patch
git apply docs/patches/FIX-2-guard.patch
git add .claude/hooks/guard.mjs scripts/test/guard.test.ts scripts/test/guard-rules.test.ts scripts/test/guard-growth.test.ts scripts/test/helpers/guard-growth.ts
git status --short
git commit -m "fix(sprint-0): make guard anchor matching linear" -m "Serves R0.5 and conductor decision 5."
git push origin sprint/0-bootstrap
```

What to expect at each step: `git branch --show-current` prints `sprint/0-bootstrap`; the first `git status --short` prints nothing (if it prints anything, stop); `git apply --check` prints nothing; the second `git status --short` shows exactly five lines, three starting with `M` and two with `A` (`scripts/test/guard-growth.test.ts` and `scripts/test/helpers/guard-growth.ts`). Run `pnpm -F @sessiondeck/scripts test` before the commit if you want to see it pass first. The final command pushes the sprint branch (never `main`) so CI runs the four jobs on it.
