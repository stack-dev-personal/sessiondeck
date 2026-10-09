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

   Uninstall works from any checkout that still has the installer, also one that has since moved,
   because our entries are recognised by the fixed argument pair `--marker`, `sessiondeck-capture`
   (adjacent, as separate items of `args`, or as whole words in a status line command) and by the
   exact entries recorded in the state file, not by the path of the script. A hook of yours whose
   path merely contains the text `sessiondeck-capture` is not touched. If no checkout has the
   installer any more, use "Manual removal" below.

### Where things land

- The deployed hook copy: `%LOCALAPPDATA%\sessiondeck\capture\` on Windows,
  `$XDG_DATA_HOME/sessiondeck/capture/` or `~/.local/share/sessiondeck/capture/` elsewhere
  (override with `SESSIONDECK_CAPTURE_HOME`). It holds the hook and exactly the lib files it
  imports, so switching branches or editing `scripts/` cannot change what runs in your sessions.
  The installer records a sha256 per file, re-hashes after copying, and replaces a file that no
  longer matches on the next install. It refuses a directory inside a git work tree, and checks
  after creating each directory that it still resolves inside the deploy directory (a junction or
  symlink planted at `<deploy>/lib` is refused). It also writes `UNINSTALL.txt` there (the manual
  steps below), so the instructions exist when no checkout does. Uninstall deletes a file only if
  it sits in the real deploy directory and its sha256 still equals the record, then the directory
  if it is empty; a changed file is kept and named. If the deploy directory changes between two
  installs (`SESSIONDECK_CAPTURE_HOME`), the earlier copy is removed by the same rules.
- Raw payloads: `packages/contract/fixtures/raw/<Event>/<epoch ms>-<session>-<random>.json`, plus
  `statusLine/`, `subagentStatusLine/`, and `_unparsed/` for input that was not a JSON object. The
  absolute path is fixed at install time (use `--out <dir>` to choose another).
- Problems inside the hook go to `<raw>/_capture-errors.log` (error codes only, never payload content).
  The first time a cap or the byte budget refuses a payload, one line says so (`full-budget`,
  `full-cap-<Event>`, `full-dirs`), and the status line then reads `sessiondeck capture full`
  instead of `sessiondeck capture on`. A line in `_usage.log` larger than the whole budget is ignored.
- The raw directory is NOT scrubbed: it holds your prompts, file contents, and possibly secrets.
  Never commit or share it. Three guards: the repository ignore rule for `fixtures/raw/`, a
  `.gitignore` containing `*` that the hook and installer write into the directory (and rewrite if
  its content is anything else), and an install
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
  Uninstall trusts it only as far as the settings file itself is trusted: it must pass a shape
  check, the recorded entries must carry the marker pair, a `deploy.dir` that differs from the
  directory this run resolves to is never followed (both paths are printed, the settings entries
  are still removed, and the exit code is 1), and the one value it can put back into your settings
  is a previous status line that is a JSON object without the marker.
- Backups are full copies of your settings, so they can contain tokens from `env`. At the end of
  `--uninstall --apply` the installer lists every backup path; delete them yourself when you no
  longer need them (for example `rm <path>`). On Linux and macOS the backups, the state file and
  the temp files are created owner-only (0600) and the rewritten `settings.json` keeps its
  original mode; on Windows they inherit the directory ACLs.
- `--uninstall` removes only our entries, puts your status lines back if they are still ours, and
  keeps everything else you changed during the day. It does not restore the whole file from a
  backup, because that would discard those changes.
- Fail closed: if the state file exists but no entry in the settings file is recognised, or entries
  carrying the marker remain after the run, the state file and the deployed copy are kept, what is
  still installed is listed, and the exit code is 1. A malformed state file also stops both install
  and uninstall with a clear message and changes nothing.
- A symlinked `settings.json` is refused rather than replaced. If the file changes between the
  installer reading it and writing it, the run aborts: the settings, the state file and the backup
  are left as they were, and the deployed files that this run created are removed again (files of
  an earlier install that were refreshed stay refreshed).
- Every hook entry that install or uninstall removes or replaces is printed as a `-` line, also
  inside a group shared with your own hooks. The installer never removes an entry that lacks the
  marker pair.
- Uninstall without a prior install does nothing. Installing twice gives the same result as once.

### Manual removal (no checkout has the installer)

The same text is deployed as `UNINSTALL.txt` next to the hook copy.

```
sessiondeck fixture capture: manual removal

Use this when the installer (scripts/capture-install.mjs) is no longer on disk.
Close or ignore running Claude Code sessions first; they reload settings live.

1. Open the settings file: settings.json inside the directory named by the CLAUDE_CONFIG_DIR
   environment variable if it is set, otherwise inside ~/.claude.
2. Under "hooks", for each of these events, delete the hook entries whose "args" list holds the two
   items "--marker" and "sessiondeck-capture" next to each other (a "group" with no hooks left
   goes too; keep every other hook): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
   PostToolUseFailure, PermissionRequest, PermissionDenied, Notification, SubagentStart,
   SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, PreCompact, PostCompact,
   SessionEnd. If "hooks" ends up empty and you did not have it before, delete the key.
3. "statusLine" and "subagentStatusLine": if the "command" contains "--marker sessiondeck-capture",
   replace it with your earlier value or delete the key. The earlier value is in the "previous"
   part of settings.json.sessiondeck-capture-state.json, or in a backup (step 4).
4. Next to settings.json, delete settings.json.sessiondeck-capture-state.json and the files named
   settings.json.sessiondeck-backup-<timestamp>. Backups are full copies of your settings and can
   contain tokens; read one first if you need to restore something.
5. Delete the directory that holds this file (the deployed hook copy). It contains only the hook,
   its lib folder and this note.
6. Delete the raw capture directory. Its path is the value after "--out" in the entries you removed
   in step 2. It holds your unscrubbed prompts and file contents: never commit or share it.
```

### Safety notes

- The hook never writes to stdout (except the one status line text) and always exits 0, so it cannot
  add text to Claude's context or block an event. The `SessionEnd` entry has no per-hook timeout, so
  the documented shared 1.5 s exit budget stays in force; the other events use 5 s.
- The installer prints a diff of its own lines only, never the whole file or unrelated keys.
- The refusal inside a Claude Code session compares real paths (links, junctions, extended-length
  prefixes) against `<home>/.claude` and the account's own home. It stops accidents, nothing more:
  a config directory relocated with `CLAUDE_CONFIG_DIR` is indistinguishable from a sandbox, and
  an unset `CLAUDECODE` disables it. The project's `guard.mjs` hook is the actual control.
- The hook loads its lib files with dynamic imports inside its try block. If one is missing or
  broken the hook still exits 0 with empty stdout and stderr, and records nothing until you
  reinstall. The deployed copy is writable by anything running as you and is only re-hashed at
  install time.
- Tests set `CLAUDE_CONFIG_DIR`, `SESSIONDECK_CAPTURE_HOME`, `HOME`, `USERPROFILE`, `LOCALAPPDATA`,
  and `XDG_DATA_HOME` to a fresh temp directory and assert the printed target is inside it.

### Tests

```
pnpm -F @sessiondeck/scripts test
```
