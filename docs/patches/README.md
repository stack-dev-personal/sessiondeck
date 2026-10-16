# Patches

## S0b-claude-dir.patch

Claude Code refused headless edits under `.claude/` in session S0b, so the conductor decision 4 and 5 changes are carried as a patch. It changes:

- `.claude/hooks/guard.mjs`: blocks `node`, `node.exe` or `npx` running the `capture-install` script with `--apply` (plain, quoted, backslash paths, either flag order, inside `cmd /c`, `powershell -c`, `$(...)`, backticks, line continuations). It prevents accidents by a well-behaved session; it is not a defence against a hostile one. Renamed copies, variables, split quoting, globs and encoded commands get past it (listed as known gaps in the tests), and a compromised session already has the user's privileges. Previews without `--apply`, `--apply-later`, and commands that only mention the flag (grep, git log, commit messages) stay allowed.
- `.claude/settings.json`: two `Read(...)` deny entries for the default capture directory under local app data (best effort: Bash reads, a non-default `LOCALAPPDATA` and `SESSIONDECK_CAPTURE_HOME` are not covered).
- `.claude/skills/fixture-capture/SKILL.md`: raw files land in `%LOCALAPPDATA%/sessiondeck/capture/raw/<event>/...`, copied to `packages/contract/fixtures/raw/` by `scripts/UNINSTALL.txt` step 5; install step says to run `--apply` yourself.
- `scripts/lib/settings-files.mjs`: one comment updated to describe the guard rule.
- `scripts/test/guard.test.ts` (new): tests for the guard rule (blocked, allowed, known gaps) and the deny array.

Apply in `C:/Users/stack/projects/wt/S0b` (branch `p0/fixtures`), or after the conductor merges this branch, in a checkout of `sprint/0-bootstrap`. Never apply or commit on `main`: the user's main checkout has no `docs/patches/`. Run it in a plain terminal:

```
git apply docs/patches/S0b-claude-dir.patch
```

Then `pnpm -F @sessiondeck/scripts test` and commit the five files.
