# scripts

Workspace package `@sessiondeck/scripts`. Node scripts. The fixture capture scripts use Node
built-ins only; the sprint prompt renderer uses the `yaml` package.

## Fixture capture (R0.7 tooling)

Claude Code payloads are only partly documented. These scripts record the real ones during a normal
working day so the contract is tested against what your machine actually sends. Scrubbing and
committing the fixtures is a later session (S0b).

### Capture-day procedure

Run every command below yourself, from a plain terminal. Do not run them from inside a Claude Code
session: when `CLAUDECODE` is set and the target is your real config directory, the installer
refuses (even for a preview, because a preview prints status line data).

1. Preview. This is the default (`--dry-run` is the explicit spelling of the same thing), it writes
   nothing, and it prints only the lines the install would add or remove. A status line or subagent
   status line of yours is shown as type and length only.

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
   line shows `sessiondeck capture on` until you uninstall; the subagent status command records
   the payload and prints nothing, so Claude Code keeps its default subagent rows (only an empty
   `content` would hide one). The raw capture directory is printed (see "Where things land": it is
   outside every work tree, so choose `--out <dir>` only if you want it elsewhere, and never inside
   a worktree you may remove). Claude Code reloads settings live, so capture starts in every
   running session as soon as the installer writes the file.

3. Work normally for a day. Do the items below early in the day, not at the end: each event keeps
   at most 3000 files, and when a limit stops recording the status line reads
   `sessiondeck capture full` instead of `sessiondeck capture on` (see "Disk use" below). If you
   see `full`, open `<raw>/_capture-errors.log` first: it names what stopped. `error` means a
   write failed; read `<raw>/_capture-errors.log` for the code. For `full-budget` or `full-dirs`,
   move (never delete) the raw directory before you do the remaining items, so new events are
   recorded again. For `full-cap-<Event>` do nothing. The two status line sample
   caps (`full-cap-statusLine`, `full-cap-subagentStatusLine`) fill on a normal day, need no action
   and do not change the status line text.
   Make sure the day includes:
   - at least two different projects
   - one long session, so `rate_limits` shows up in the status line payload (about 20 samples, one
     per 30 seconds, so ten minutes of one session)
   - one session that uses subagents
   - one `/compact`
   - one permission prompt that you answer (needs the default permission mode: in bypass or auto
     mode no `PermissionRequest` is sent)
   - one command that fails (gives `PostToolUseFailure`)
   - one task list (gives `TaskCreated` and `TaskCompleted`)
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
   installer any more, use "Manual removal" below. Uninstall never deletes the raw captures: it
   prints their recorded path and the next step: one `git check-ignore` check and one exact copy
   command per shell (PowerShell, bash) that creates `packages/contract/fixtures/raw/` in the
   checkout where the fixture session S0b (branch `p0/fixtures`) runs and copies the contents of
   the raw directory into it. The same commands are in step 5 of "Manual removal" below.

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
- Raw payloads: `<deploy home>/raw/<Event>/<epoch ms>-<session>-<random>.json`, that is
  `%LOCALAPPDATA%\sessiondeck\capture\raw\` on Windows and `$XDG_DATA_HOME/sessiondeck/capture/raw/`
  (else `~/.local/share/sessiondeck/capture/raw/`) elsewhere, plus `statusLine/`,
  `subagentStatusLine/`, and `_unparsed/` for input that was not a JSON object. This is a durable
  directory outside every work tree, so removing a worktree or switching branches cannot delete the
  captures. Install prints the resolved path (also in the preview), and the absolute path is fixed
  at install time (`--out <dir>` chooses another one, with the same refusals for a git work tree
  that does not ignore it and for the committed fixtures layout). Uninstall never deletes the raw
  directory, prints the path recorded at install, and leaves the deploy directory in place while
  raw is inside it. The path is printed only if it equals the `--out` value of the entries that
  were removed. Next step after uninstalling: the copy commands described in step 4 above and in
  step 5 of "Manual removal"; the target is gitignored in the S0b checkout.
- Problems inside the hook go to `<raw>/_capture-errors.log` (error codes only, never payload content).
  The first time a cap or the byte budget refuses a payload, one line says so (`full-budget`,
  `full-cap-<Event>`, `full-dirs`; the two status line sample caps are logged the same way but
  are left out of this signal), and from then on the status line reads `sessiondeck capture full`
  instead of `sessiondeck capture on`, whichever event hit the limit. `full` means at least one
  kind of payload is no longer being recorded; the other kinds may still be. A line in `_usage.log` larger than the whole budget is ignored.
- The raw directory is NOT scrubbed: it holds your prompts, file contents, and possibly secrets.
  Never commit or share it. Three guards: the repository ignore rule for `fixtures/raw/` (where the
  copy ends up), a
  `.gitignore` containing `*` that the hook and installer write into the directory (and rewrite if
  its content is anything else), and an install
  time check that refuses an out dir inside a git work tree unless `git check-ignore` confirms it is
  ignored. The installer also refuses `packages/contract/fixtures` itself and anything else that
  would mix raw files into the committed `fixtures/<Event>/` layout. S0b produces the scrubbed
  copies under `fixtures/<Event>/`.
- Disk use is bounded: at most 3000 files per event (the 256 MiB total is the real bound), 1000 status line samples (one per session every
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
  is a previous status line that is a JSON object without the marker. That status line runs a
  command, so uninstall prints a line naming each restored key; check what it runs. Paths read
  from the state file are printed with control characters replaced.
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
   part of settings.json.sessiondeck-capture-state.json, or in a backup (step 4). A status line
   put back from that file runs a command: read it before you keep it.
4. Next to settings.json, delete settings.json.sessiondeck-capture-state.json and the files named
   settings.json.sessiondeck-backup-<timestamp>. Backups are full copies of your settings and can
   contain tokens; read one first if you need to restore something.
5. Keep the raw captures. Their path is the value after "--out" in the entries you removed in step 2
   (by default the "raw" folder next to this file). If the fixture session (S0b, branch
   p0/fixtures) has not copied them yet, copy the CONTENTS of that folder into
   packages/contract/fixtures/raw/ of the checkout where it runs (replace <raw> and <checkout>).
   First run this in that checkout; it must print a matching rule, otherwise stop:
     git check-ignore -v packages/contract/fixtures/raw/x
   PowerShell:
     New-Item -ItemType Directory -Force '<checkout>/packages/contract/fixtures/raw'; Copy-Item -Recurse -Force '<raw>/*' '<checkout>/packages/contract/fixtures/raw'
   bash:
     mkdir -p '<checkout>/packages/contract/fixtures/raw' && cp -R '<raw>/.' '<checkout>/packages/contract/fixtures/raw/'
   They hold your unscrubbed prompts and file contents: never commit or share them, and delete the
   folder once S0b has its copy.
6. Delete the deployed hook copy: the files in this directory (the hook, its lib folder and this
   note), but not the "raw" folder until step 5 is done.
```

### Safety notes

- The hook never writes to stdout (except the one status line text) and always exits 0, so it cannot
  add text to Claude's context or block an event. The `SessionEnd` entry has no per-hook timeout, so
  the documented shared 1.5 s exit budget stays in force; the other events use 5 s.
- The installer prints a diff of its own lines only, never the whole file or unrelated keys.
- The refusal inside a Claude Code session compares real paths (links, junctions, extended-length
  prefixes) against `<home>/.claude` and the account's own home. It stops accidents, nothing more:
  a config directory relocated with `CLAUDE_CONFIG_DIR` is indistinguishable from a sandbox, and
  an unset `CLAUDECODE` disables it (an agent that runs
  `env -u CLAUDECODE node scripts/capture-install.mjs --apply` without `CLAUDE_CONFIG_DIR` gets
  past it). The project's `.claude/hooks/guard.mjs` is NOT a control for this yet: it matches only
  the literal text `.claude/settings.json`, and no guard rule for `capture-install` exists. Before
  capture day, add that rule and Read deny rules for the raw and deploy directories to the
  project's permissions, or run the installer only yourself from a plain terminal.
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

## Sprint prompt renderer

`scripts/sprint/render-prompt.mjs` fills the level-1 prompt (PROMPT-BOOK.md section 3, with the
section 1 preamble) from one package block of MINI-SPRINT-ORDER.md.

```
node scripts/sprint/render-prompt.mjs --sprint <id> [--contract-sha <sha>] [--out <file>] [--package-json] [--repo-root <dir>]
```

- `--sprint` is `0` to `5`, or `smoke` (built in; renders the one-line smoke prompt, no preamble).
- `--contract-sha` is required for every sprint except `0`, which renders `n/a` without it.
- `--package-json` prints the parsed package (sprint, name, slug, branch, runs_in, max_parallel,
  depends_on, user_gates, sessions, merge_order) instead of the prompt. The launcher refuses to start
  a container when `runs_in` is `local` (Sprint 0).
- `--out` writes atomically (temp file, then rename) with LF endings and creates the parent directory.
  Without it the text goes to stdout.
- `{SESSION_ID}` and `{SESSION_BRANCH}` stay literal for the sprint orchestrator. Any other braced
  token in the template (typo, wrong case, `{n}`) is an error that names it.
- A package block is rejected, naming the sprint and key, for: a missing or mistyped key; an unknown
  key (misspellings such as `user_gates` on a session); a string value that spans lines or contains a
  `{PLACEHOLDER}` token (write `${VAR}` for shell syntax); `branch` other than `sprint/<id>-<slug>`;
  `merge_order` that is not every session id once; empty `integration_checks`; a session `depends_on`
  that names no session in the sprint; a yaml fence in section 3 without a `### Sprint <id>:` heading.
- Started through a junction or symlink, the CLI resolves the real path before it decides to run.
- `needs_laptop` and `notes` from the block are appended as two bullets after the template's package list.
- Exit codes: 0 ok, 2 usage (flags, unknown sprint, missing contract sha), 3 malformed input or
  unfilled placeholder, 4 file read or write failure. Messages go to stderr.

## Sprint container scripts (R0.8)

`scripts/sprint/*.ps1` start, watch and stop the sprint containers. All four are written for Windows
PowerShell 5.1 and PowerShell 7 and tested on Windows PowerShell 5.1 only. Setup, the security note (the docker socket is root-equivalent), parameters in
full and the container contract are in `infra/sprint/README.md`; read that first.

| Command | Parameters | Exit codes |
|---------|------------|------------|
| `scripts/sprint/run-sprint.ps1` | `-Sprint`, `-Resume`, `-ContractSha`, `-DryRun`, `-EnvFile`, `-RepoRoot`, `-StateRoot`, `-RepoUrl`, `-AllowForeignRepo`, `-Image`, `-AllowForeignImage`, `-Build` | 0 started or dry run ok; 2 bad input; 3 prerequisite missing, origin unreadable, renderer failure, or a docker target that is not local (`DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT` or the saved context); 4 already running or state conflict; 5 docker failure |
| `scripts/sprint/stop-sprint.ps1` | `-Sprint`, `-DryRun` | 0 stopped or nothing to stop; 2 bad input; 3 docker missing; 5 docker failure |
| `scripts/sprint/status.ps1` | `-Root` | 0 whenever it reaches the table, including "nothing to show"; a link in the state directory shows as `link refused` |
| `scripts/sprint/smoke-check.ps1` | `-EnvFile`, `-StateRoot`, `-RepoRoot`, `-TimeoutSeconds`, `-PollSeconds`, `-KeepContainer`, `-EvidenceFile` | 0 PASS (smoke status green); 1 FAIL (timeout, container exited, not green, unexpected error inside `run-sprint`); 2, 3, 4, 5 passed through from `run-sprint.ps1`; 3 also for a remote docker target (checked before the image query), 4 also for a link in the state directory |

`smoke-check.ps1` is the R0.8 smoke gate in one command (run, wait for green, evidence block, stop); it clears
the previous `smoke/status.json` first and prints only sanitized status and log text. The wait limit
counts from the moment `run-sprint` returns (an image build is reported separately as `start_seconds`),
and `stop-sprint` is skipped with `-KeepContainer` and after `run-sprint` exit 1, 2, 3 or 4. The sprint id is letters,
digits and underscore only. The container can plant symbolic links in `.sprint/<id>/`; `run-sprint.ps1`, `smoke-check.ps1` and `status.ps1` refuse any path that is, or sits under, a link below the state root (`lib/sprint-links.ps1`; see the Links bullet in `infra/sprint/README.md`). Tests: the static ones run in
`pnpm -F @sessiondeck/scripts test`; the PowerShell script tests are `test:sprint-ps`, a separate CI
step.
