# Patches

## S0b-claude-dir.patch

Claude Code refused headless edits under `.claude/` in session S0b, so the conductor decision 4 and 5 changes are carried as a patch. It changes:

- `.claude/hooks/guard.mjs`: blocks `node`, `node.exe` or `npx` running the `capture-install` script with `--apply` (plain, quoted, quoted paths with spaces, backslash paths, either flag order, env or `VAR=` prefixes, `pnpm exec`, `time`, `if`/`then`, braces, `node -r x`, `cmd /c`, `powershell -c`, `$(...)`, backticks, line continuations, a trailing redirect). It prevents accidents by a well-behaved session; it is not a defence against a hostile one. Renamed copies, variables, split quoting, globs and encoded commands get past it (listed as known gaps in the tests), and a compromised session already has the user's privileges. Previews without `--apply`, `--apply-later`, and commands that mention the flag without a leading `node` (grep, git log, commit messages) stay allowed. Known false positives (fail closed, listed in the tests): a command that quotes the whole `node ... --apply` line, such as a grep pattern, an echo or a commit message containing it, is blocked.
- `.claude/settings.json`: two `Read(...)` deny entries for the default capture directory under local app data (best effort: Bash reads, a non-default `LOCALAPPDATA` and `SESSIONDECK_CAPTURE_HOME` are not covered).
- `.claude/skills/fixture-capture/SKILL.md`: raw files land in `%LOCALAPPDATA%/sessiondeck/capture/raw/<event>/...`, copied to `packages/contract/fixtures/raw/` by `scripts/UNINSTALL.txt` step 5; install step says to run `--apply` yourself.
- `scripts/lib/settings-files.mjs`: one comment updated to describe the guard rule.
- `scripts/test/guard.test.ts` (new): tests for the guard rule (blocked, allowed, known gaps) and the deny array.

Apply in `<S0b worktree>` (branch `p0/fixtures`), or after the conductor merges this branch, in a checkout of `sprint/0-bootstrap`. Never apply or commit on `main`: the user's main checkout has no `docs/patches/`. Run it in a plain terminal:

```
git apply docs/patches/S0b-claude-dir.patch
```

Then `pnpm -F @sessiondeck/scripts test` and commit the five files.
