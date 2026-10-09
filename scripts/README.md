# scripts

Workspace package `@sessiondeck/scripts`. Dependency-free Node scripts (Node built-ins only).

## Fixture capture (R0.7 tooling)

Claude Code payloads are only partly documented. These scripts record the real ones during a normal
working day so the contract is tested against what your machine actually sends. Scrubbing and
committing the fixtures is a later session (S0b).

### Capture-day procedure

1. Preview. This writes nothing and prints only the lines the install would add or remove:

   ```
   node scripts/capture-install.mjs --dry-run
   ```

   The first line printed is the settings file it would change (`settings.json` inside
   `CLAUDE_CONFIG_DIR` if that variable is set, else inside `~/.claude`). Check it.

2. Install:

   ```
   node scripts/capture-install.mjs
   ```

   It registers a capture hook on all 17 events, next to any hooks you already have (yours stay
   exactly as they are and keep running). It also replaces `statusLine` and `subagentStatusLine`.
   Your status line shows `sessiondeck capture on` and the subagent rows are hidden until you
   uninstall. Start new Claude Code sessions afterwards; running sessions may not pick up the change.

3. Work normally for a day. Make sure the day includes:
   - at least two different projects
   - one long session, so `rate_limits` shows up in the status line payload
   - one session that uses subagents
   - one `/compact`
   - one permission prompt that you answer
   - one AskUserQuestion
   - one `/clear`
   - one session you end by killing the terminal (for the liveness fixtures later)

4. Uninstall:

   ```
   node scripts/capture-install.mjs --uninstall
   ```

### Where things land

- Raw payloads: `packages/contract/fixtures/raw/<Event>/<epoch ms>-<session>-<random>.json`, plus
  `statusLine/`, `subagentStatusLine/`, and `_unparsed/` for input that was not a JSON object.
- Problems inside the hook go to `packages/contract/fixtures/raw/_capture-errors.log` (error codes
  only, never payload content).
- `packages/contract/fixtures/raw/` is gitignored. The files are NOT scrubbed: they contain your
  prompts, file contents, and possibly secrets. Never commit or share them. S0b produces scrubbed
  copies under `packages/contract/fixtures/<Event>/`.
- Disk use is bounded: at most 500 files per event, 1000 status line samples (one per session every
  30 seconds, plus one whenever the set of keys or the presence of `rate_limits` changes), 300
  subagent status samples, 100 unparsed inputs.

### Backups and uninstall

- Before every write the installer copies the settings file next to itself as
  `settings.json.sessiondeck-backup-<timestamp>`. Backups are never overwritten and never deleted.
- A small state file `settings.json.sessiondeck-capture-state.json` records your previous
  `statusLine` and `subagentStatusLine`. `--uninstall` removes only our entries, puts your status
  lines back if they are still ours, and keeps everything else you changed during the day. It does
  not restore the whole file from the backup, because that would discard those changes. The backups
  stay for manual recovery.
- Uninstall without a prior install does nothing.
- Installing twice gives the same result as installing once.

### Safety notes

- The hook never writes to stdout and always exits 0, so it cannot add text to Claude's context or
  block an event.
- The installer prints a diff of its own lines only, never the whole file or unrelated keys.
- Tests set `CLAUDE_CONFIG_DIR` to a fresh temp directory and point `HOME` and `USERPROFILE` there too.

### Tests

```
pnpm -F @sessiondeck/scripts test
```
