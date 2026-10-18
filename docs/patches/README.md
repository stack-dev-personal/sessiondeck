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

It changes exactly three files:

- `.claude/hooks/guard.mjs`:
  - Push rules (all three): the match must start at the beginning of the command or after `| ; &`, and a lookahead finds the first `git push` of that segment once (a lookahead is atomic in JS, so later occurrences are never retried). The tail pattern is unchanged. Each segment is scanned by one start. Later occurrences cannot change a verdict: if one had the flag or main after it, the first has it too.
  - capture-install `--apply`: the node anchor is a lookahead shape (`node`, at most 32 options, the script), so the match is the node part only. The `--apply` check runs once for that candidate, from its end to the end of its segment, instead of in a lookahead at every anchor. If the flag is missing, matching resumes after that segment. The unquoted path prefix no longer allows `{` (a run of `{` made each start rescan the run; `{` is itself an anchor, so verdicts stay the same).
  - Review round 1 fixes (both HIGH, plus one more of the same kind found while proving them): an option is `-[\w.-]+` (was `--?[\w.-]+`, where `--a` parsed as `--`+`a` or `-`+`-a`, so 33 options gave 2^33 paths); option values exclude a backslash that starts a backslash-newline (`-a x\<LF>` had two parses per option, 2^k, and the old guard has it too: 33 of them were killed at 20 s); the segment skip is `(?:\x5c\r?\n|[^|;&\n])*` (continuation first, like the flag scan, so a continued line is skipped in one pass instead of rescanned per candidate).
  - `rm -rf` rule: the flag token class is split (letters before the first `r`, or before the first `f`, exclude that letter) so `rm -rrrr...` is no longer quadratic. Found while proving the fix: `rm -` plus 100k `r` took 6.3 s.
  - The header comment states the argument rule by rule and names the test row for each claim.
- `scripts/test/guard.test.ts`: 18 new timing rows in the `timingInputs` table (about 100k characters each, plus the 244-character option shapes), five growth rows (the same shape at N and 4N, best of 3 each; ratio must stay under `MAX_GROWTH_RATIO` 8, a quadratic gives 16; values under a 5 ms floor are clamped so noise cannot fail it; the large run also keeps the absolute 150 ms and 300 ms bounds), a unit test of the ratio helper, the three existing blocked capture-install rows now expect 9 regex calls instead of 8, and the call-count comment explains each count.
- `scripts/test/guard-rules.test.ts`: three rows in `knownGaps` (expected ALLOWED), see below.

Behaviour changes and known gaps (all three rows are in `knownGaps`; they would fail against the current guard):

- More than 32 options between `node` and the capture-install script is no longer recognised (`node` plus 40 `-r x` plus `capture-install --apply` is allowed; the old guard blocked it). Accepted: a well-behaved session does not do this, and the rule is accident prevention, not a defence against a hostile session.
- The matcher is not quote aware. A `;` inside a quoted argument ends the segment for the flag check, so `node capture-install "x;)/node" capture-install --apply` was blocked by the old guard (by luck) and is allowed by the patch. `node capture-install "a;b" --apply` is allowed by both. These sit with the other quote-unaware cases already listed in `knownGaps` (split quoting, variables, globs, renamed copies).
- Differential run of old versus new guard: see Evidence. The only verdict differences are these two gap shapes.

Evidence (temporary detached worktree on 839604d with offline install, removed afterwards):

- RED, current guard (839604d), new round 1 rows, `workMs` or regex time against the 150 ms and 300 ms bounds: `node` plus `--a b` x33 plus `node scripts/capture-install.mjs --apply` (one segment, 243 chars) killed at the 4000 ms wall limit (20 s when run by hand); `node` plus `-a x` backslash-LF x33 plus the same tail killed at 4000 ms (20 s by hand); `echo --apply; ` plus `node capture-install \<LF>` x4500 (99k) 650 ms, CRLF 601 ms, growth 30 ms to 435 ms (ratio 14.3); the 40-option and `"x;)/node"` gap rows fail (current guard blocks them). `node` plus `--a b` x33 then `; node scripts/capture-install.mjs --apply` (cross segment, the first-patch exploit) takes 5 ms on the current guard and fails only on the call count (8, expected 9); the `--x=node` x7000 row likewise (8 vs 9). Against the previous version of this patch both of those, and the 33-option one-segment row, are killed at 4000 ms (20 s by hand), which is the regression the review found; the continuation rows are 675 ms and 579 ms there.
- RED from the first round (current guard, unchanged): `git push ` x 11000 (99k) 3040 ms; `git push -` x 10000 3460 ms; `git push origin ` x 6250 plus `main` 1357 ms; `node ` x 20000 plus `--apply capture-install` 1384 ms; `node -x ` x 12500 1660 ms; `rm -` plus 100k `r`, and 100k `{` plus ` capture-install --apply`, killed at 4000 ms.
- GREEN, patched guard: `pnpm -F @sessiondeck/scripts test` three times, each 582 passed and 3 skipped (the existing skips), 31 to 34 s in total (guard.test.ts 26 to 29 s, guard-rules.test.ts 29 to 31 s, run in parallel workers; was 24 s); `pnpm -r test` once, contract 1091 passed and scripts 582 passed; typecheck, `pnpm lint`, `prettier --check .` clean. Every new timing row matches in 1 to 6 ms (`--x=node` 20 ms, `node -x ` 26 ms). Growth rows (workMs at N and 4N): `git push ` 4.9 to 5.6 ms (ratio 1.1), continuation 5.6 to 8.4 (1.5), `--x=node` 10.1 to 27.6 (2.7), option count k=16 to 64 5.0 to 5.2 (1.0), backslash-value k=16 to 64 5.1 to 5.6 (1.1). The 150 ms and 300 ms bounds are at one size, the growth rows are the check against a slow quadratic; below the 5 ms floor the ratio is not informative and only the absolute bounds apply.
- Differential fuzz, old (839604d) versus patched guard: 6000 random fragment commands (two seeds of 3000, fragments include `--a`, `-a x` backslash-LF, `--x=node`, `"x;)/node"`, continuations, 2190 blocked by the old guard), 0 differing exit codes (a hang counts as a difference; there were none). The random fragments do not generate the two known-gap shapes, so the only intended differences are the two directed `knownGaps` rows (blocked by the old guard, allowed by the patch); there are no others.

Apply in a plain terminal, in a checkout of `sprint/0-bootstrap` (never `main`; the user's main checkout has no `docs/patches/`):

```
git apply docs/patches/FIX-2-guard.patch
pnpm -F @sessiondeck/scripts test
git add .claude/hooks/guard.mjs scripts/test/guard.test.ts scripts/test/guard-rules.test.ts
git commit -m "fix(sprint-0): guard repeated-anchor matching is linear, with timing rows"
```
