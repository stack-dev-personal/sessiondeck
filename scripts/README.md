# scripts

Workspace package `@sessiondeck/scripts`. Dependency-free Node scripts (Node built-ins only).

## Fixture capture (R0.7 tooling)

Claude Code payloads are only partly documented. These scripts record the real ones during a normal
working day so the contract is tested against what your machine actually sends. Scrubbing and
committing the fixtures is a later session (S0b).

### Capture-day procedure

Run every command below yourself, from a plain terminal. Do not run them from inside a Claude Code
session: when `CLAUDECODE` is set and the target is your real config directory, the installer
refuses (even for a preview, because a preview prints status line data).

1. Preview. This is the default, it writes nothing, and it prints only the lines the install would
   add or remove. A status line or subagent status line of yours is shown as type and length only.

   ```
   node scripts/capture-install.mjs
   ```

   The first line printed is the settings file it would change (`settings.json` inside
   `CLAUDE_CONFIG_DIR` if that variable is set, else inside `~/.claude`). Check it.

2. Install. Nothing is written without `--apply`:

   ```
   node scripts/capture-install.mjs --apply
   ```

   It copies the capture hook to a fixed directory outside the repository (see below), then
   registers that copy on all 17 events, next to any hooks you already have (yours stay exactly as
   they are and keep running). It also replaces `statusLine` and `subagentStatusLine`. Your status
   line shows `sessiondeck capture on` and the subagent rows are hidden until you uninstall.
   Claude Code reloads settings live, so capture starts in every running session as soon as the
   installer writes the file.

3. Work normally for a day. Make sure the day includes:
   - at least two different projects
   - one long session, so `rate_limits` shows up in the status line payload
   - one session that uses subagents
   - one `/compact`
   - one permission prompt that you answer
   - one AskUserQuestion
   - one `/clear`
   - one session you end by killing the terminal (for the liveness fixtures later)

4. Uninstall. Preview first (the default), then apply:

   ```
   node scripts/capture-install.mjs --uninstall
   node scripts/capture-install.mjs --uninstall --apply
   ```

   Uninstall works from any checkout, also one that has since moved or been deleted, because our
   entries are recognised by a fixed `--marker sessiondeck-capture` argument and by the exact
   entries recorded in the state file, not by the path of the script.

### Where things land

- The deployed hook copy: `%LOCALAPPDATA%\sessiondeck\capture\` on Windows,
  `$XDG_DATA_HOME/sessiondeck/capture/` or `~/.local/share/sessiondeck/capture/` elsewhere
  (override with `SESSIONDECK_CAPTURE_HOME`). It holds the hook and exactly the lib files it
  imports, so switching branches or editing `scripts/` cannot change what runs in your sessions.
  The installer records a sha256 per file, re-hashes after copying, and replaces a file that no
  longer matches on the next install. It refuses a directory inside a git work tree. Uninstall
  deletes only the files named in that record, then the directory if it is empty.
- Raw payloads: `packages/contract/fixtures/raw/<Event>/<epoch ms>-<session>-<random>.json`, plus
  `statusLine/`, `subagentStatusLine/`, and `_unparsed/` for input that was not a JSON object. The
  absolute path is fixed at install time (use `--out <dir>` to choose another).
- Problems inside the hook go to `<raw>/_capture-errors.log` (error codes only, never payload content).
- The raw directory is NOT scrubbed: it holds your prompts, file contents, and possibly secrets.
  Never commit or share it. Three guards: the repository ignore rule for `fixtures/raw/`, a
  `.gitignore` containing `*` that the hook and installer write into the directory, and an install
  time check that refuses an out dir inside a git work tree unless `git check-ignore` confirms it is
  ignored. The installer also refuses `packages/contract/fixtures` itself and anything else that
  would mix raw files into the committed `fixtures/<Event>/` layout. S0b produces the scrubbed
  copies under `fixtures/<Event>/`.
- Disk use is bounded: at most 500 files per event, 1000 status line samples (one per session every
  30 seconds, plus one whenever the set of keys or the presence of `rate_limits` changes), 300
  subagent status samples, 100 unparsed inputs (each cut to 64 KiB), 200 throttle state files, and
  256 MiB in total (a running byte count in `<raw>/_usage.log`; deleting the raw directory resets
  it). Temp files left by a killed hook are removed after 10 minutes.

### Backups, state file, and uninstall

- Before every write the installer saves the exact bytes it read as
  `settings.json.sessiondeck-backup-<timestamp>` next to the settings file: one backup per install
  run and one per uninstall run. They are never overwritten and never deleted automatically.
- A state file `settings.json.sessiondeck-capture-state.json` records your previous `statusLine`
  and `subagentStatusLine`, the exact entries written, and the deployed-file record. It must hold
  your previous status lines to restore them, so it can contain whatever those commands contain.
- Backups are full copies of your settings, so they can contain tokens from `env`. At the end of
  `--uninstall --apply` the installer lists every backup path; delete them yourself when you no
  longer need them (for example `rm <path>`).
- `--uninstall` removes only our entries, puts your status lines back if they are still ours, and
  keeps everything else you changed during the day. It does not restore the whole file from a
  backup, because that would discard those changes.
- Fail closed: if the state file exists but no entry in the settings file is recognised, or entries
  carrying the marker remain after the run, the state file and the deployed copy are kept, what is
  still installed is listed, and the exit code is 1. A malformed state file also stops both install
  and uninstall with a clear message and changes nothing.
- A symlinked `settings.json` is refused rather than replaced. If the file changes between the
  installer reading it and writing it, the run aborts and writes nothing.
- Uninstall without a prior install does nothing. Installing twice gives the same result as once.

### Safety notes

- The hook never writes to stdout (except the one status line text) and always exits 0, so it cannot
  add text to Claude's context or block an event. The `SessionEnd` entry has no per-hook timeout, so
  the documented shared 1.5 s exit budget stays in force; the other events use 5 s.
- The installer prints a diff of its own lines only, never the whole file or unrelated keys.
- Tests set `CLAUDE_CONFIG_DIR`, `SESSIONDECK_CAPTURE_HOME`, `HOME`, `USERPROFILE`, `LOCALAPPDATA`,
  and `XDG_DATA_HOME` to a fresh temp directory and assert the printed target is inside it.

### Tests

```
pnpm -F @sessiondeck/scripts test
```
