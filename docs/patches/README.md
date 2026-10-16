# Patches

## S0b-claude-dir.patch

Claude Code refused headless edits under `.claude/` in session S0b, so the conductor decision 4 and 5 changes are carried as a patch. It changes:

- `.claude/hooks/guard.mjs`: blocks `capture-install ... --apply` (any path form, quoting, `node.exe`, flag order). Previews without `--apply` stay allowed.
- `.claude/settings.json`: two `Read(...)` deny entries for the capture directory under local app data (`~/AppData/...` and `//c/Users/*/AppData/...` forms).
- `.claude/skills/fixture-capture/SKILL.md`: raw files land in `%LOCALAPPDATA%/sessiondeck/capture/raw/<event>/...`, copied to `packages/contract/fixtures/raw/` by `scripts/UNINSTALL.txt` step 5; install step says to run `--apply` yourself.
- `scripts/test/guard.test.ts` (new): 21 tests for the guard rule and the deny array.

Apply from the repo root, in a plain terminal:

```
git apply docs/patches/S0b-claude-dir.patch
```

Then `pnpm -F @sessiondeck/scripts test` and commit the four files.
