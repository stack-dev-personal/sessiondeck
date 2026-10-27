# Probe

The probe runs on the laptop. It registers hooks in Claude Code's `settings.json`, appends one
envelope per hook call to a local spool, and (later units) ships the spool to the hub. This page
covers install, uninstall, where files live, and reading the spool by hand.

## Build first

The CLI and hooks are bundled into `packages/probe/dist/`. From the repo root:

```
pnpm install
pnpm -F @sessiondeck/probe build
```

This produces `dist/probe.mjs` (CLI), `dist/hook.mjs`, `dist/statusline.mjs`, `dist/subagents.mjs`.
With `--runtime node`, `probe install` registers the absolute path of the `dist/` it runs from, so install from the
checkout you intend to keep; rerun `install` after moving it (it replaces its own entries).

## Tests

```
pnpm -F @sessiondeck/probe test        # fast in-process unit tests: no child processes, no build
pnpm -F @sessiondeck/probe test:proc   # every suite that spawns the built entries (*.proc.test.ts)
```

`test:proc` uses `vitest.proc.config.ts`, which builds `dist/` first (global setup) and has long
timeouts for Windows CI: hook robustness (R1.2), the 50-process stress run (R1.3), statusline and
subagents processes (R1.9), and CLI install, uninstall and config (R1.8, R1.10).

## Install

```
node packages/probe/dist/probe.mjs install --hub http://192.168.1.20:8787 --token-file C:/secrets/sd-token.txt
```

- Settings file: `$CLAUDE_CONFIG_DIR/settings.json` if `CLAUDE_CONFIG_DIR` is set, else the default
  Claude Code user settings file. `--settings <path>` overrides both. Run it from a plain terminal.
- Hooks: one exec-form group per event (17 events: SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied, Notification, SubagentStart,
  SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, PreCompact, PostCompact, SessionEnd),
  `"command": "node"`, `"args": ["<abs forward-slash path>/dist/hook.mjs", "--home", "<probe home>",
"--host", "<host>", "--sessiondeck-probe"]`, `"timeout": 5`. The probe home and host are
  resolved at install time and passed as arguments: the hook never reads `SESSIONDECK_HOME`,
  `XDG_STATE_HOME` or any other env var for its location, so an env block in a repo's
  `.claude/settings.local.json` cannot redirect where it writes. Without `--home` the hook uses
  the platform default (below). The trailing `--sessiondeck-probe` argument is the marker that
  lets install and uninstall recognise the probe's own entries.
- Existing hooks, matchers, `permissions`, `env` and every other key are left as they are. Our
  group is appended after yours (or, on a re-run, stays where it was). Re-running install changes
  nothing (byte-identical file, no new backup).
- `statusLine` and `subagentStatusLine` are set only if absent or already ours. If you have your
  own, install leaves it and prints a notice. When set by us, their commands carry the same
  `--home` and `--host` (`node <script> --home <home> --host <host> --sessiondeck-probe`, tokens
  double-quoted when they contain spaces). `--statusline=replace` takes over; the previous value
  is saved in `install-state.json` and `uninstall` puts it back exactly. Paths in the command may use only `[A-Za-z0-9 _./:=+-]`; anything else (curly quotes, `%`, `$`, `,`, `@`, non-ASCII) makes install refuse.
- Before the first write the original is copied to `<probe home>/settings.backup-<timestamp>.json`.
  Writes are atomic (temp file, fsync, rename, with retry for Windows sharing violations).
- A settings file that is not valid JSON (or has a wrongly shaped `hooks`) is refused: non-zero
  exit, nothing changed.
- The file is re-serialized with its own indent and trailing-newline style. A file that was
  hand-aligned (for example inline arrays) is normalised to plain `JSON.stringify` layout once.

### Exe form (default) and the Node fallback

`probe install` defaults to `--runtime exe`: the three Bun-compiled programs (hook, statusline,
subagents) are copied from `dist/exe/windows-x64/*.exe` (Windows) or `dist/exe/linux-x64/*` (Linux,
WSL2) into `<probe home>/bin/<12-hex content hash>/` and registered in exec form. `"command"` is the
installed exe (realpath spelling, forward slashes) and `"args"` are the Node form's flags without the
script: `["--home", "<home>", "--host", "<host>", "--sessiondeck-probe"]`. The statusLine and
subagentStatusLine commands are `<exe> --home <home> --host <host> --sessiondeck-probe`. When the exe
path contains a space (for example a Windows user "Jane Doe"), a quoted first word would not run in
both Git Bash and PowerShell, so only those two commands are written in the Node form
(`node "<dist script>" <same flags>`, exactly what `--runtime node` writes); hooks keep the exe form,
install prints a notice, and `install-state.json` records `"statusRuntime": "node"`. Same source
code either way, so no behavior fork.

- Build the exes first: `pnpm -F @sessiondeck/probe build && pnpm -F @sessiondeck/probe build:exe`.
  Bun 1.4.4 (MIT, pinned devDependency, used as a build tool only, no code copied) compiles them from
  the same `dist/*.mjs` bundles the Node form runs, so there is no behavior fork. If an exe is
  missing, install exits 1 naming that command and writes nothing (no settings, no config, no copy).
- Copy: temp name in the target directory, SHA-256 of the copy checked against the source, then
  rename. The directory is named by the content hash, so a new build lands in a new directory and
  re-install works while a `hook.exe` is running (Windows locks running exes). Settings are switched
  to the new directory, then the previous directory named in `install-state.json` is removed (best
  effort, with a notice if a lock prevents it). Only a directory directly under `<home>/bin` named by
  the install record is ever removed; uninstall removes the recorded directory too. The record is
  validated when read (a forged `exeDir` is dropped), the directory must hold only the exes and stray
  `.tmp` copies, a directory another settings file's install still records (the home is shared across
  profiles) is kept, and uninstall does not prune when the home was inferred from the hook entries and
  is not the CLI default (pass `--home`).
- Freshness: `build:exe` writes `sources.json` (SHA-256 of `dist/hook.mjs`, `statusline.mjs`,
  `subagents.mjs`) next to the exes. Install refuses exes whose bundles differ from the current
  `dist/*.mjs` (or that have no `sources.json`) and names `pnpm -F @sessiondeck/probe build:exe`.
  A custom `--exe-dir` is checked only when it has a `sources.json`.
- Home safety: the exe form applies the same rule as `probe daemon install`. On Windows the home must
  be the profile default or beneath it (a folder such as `C:sd` inherits "Authenticated Users:
  Modify" and another account could swap `hook.exe`); on POSIX it must be owned by you and not
  group/world writable, and so must its parent (a sticky parent such as `/tmp` is accepted).
  Otherwise install exits 1 before writing anything; `--runtime node` is not restricted.
- Environment: the compiled exe honors Bun runtime variables (`BUN_INSPECT`, `BUN_OPTIONS`,
  `BUN_CONFIG_*`) the way the Node form honors `NODE_OPTIONS`. Whoever can set them can already run
  code through project-settings hooks, so this adds no capability.
- Permissions: Linux directories `0700`, binaries `0755`. Windows: no ACL of its own; the probe home
  inherits from `%USERPROFILE%\AppData\Local`, which is user-only by default (same model as
  `install-state.json`). Claude Code runs this exe on every hook, so keep `--home` somewhere only you can write.
- `--runtime node` installs the Node form exactly as before (`"command": "node"`, script path in
  `args`) and removes the recorded exe directory. The chosen runtime is recorded as `runtime` in
  `install-state.json`. Switching either way replaces only entries carrying the
  `--sessiondeck-probe` marker; uninstall removes both forms the same way.
- `--exe-dir <dir>` takes the three exes from `<dir>` instead of `dist/exe/<platform>` (custom builds, tests).
- Other platforms (macOS, ARM) have no prebuilt exe: use `--runtime node`.

### Token and config

`probe.json` in the probe home holds `hubUrl`, `token`, `host`. Host defaults to `os.hostname()`,
plus a `-wsl` suffix inside WSL2 (`/proc/version` mentions "microsoft") so Windows and WSL2 on one
laptop are different hosts; `--host-name <name>` overrides (letters, digits, `.`, `_`, `-`). The
host is passed to the hook and statusline as `--host`; the hook falls back to the same
hostname rule only when `--host` is absent.
It never lives in `settings.json`, and the token is never on the command line: argv is visible to
other processes, so `--token <value>` is rejected. Use `--token-file <path>` or `--token-stdin`.
Re-running install keeps the existing token unless a new one is given. `probe config show` prints
the config with the token masked.

Permissions: POSIX file `0600`, directory `0700` (set and verified on the open descriptor before
any data is written). Windows: `icacls <file> /inheritance:r /grant:r *<your SID>:F` followed by `/remove:g *S-1-5-18 *S-1-5-32-544 *S-1-3-4` (the creating process's default DACL can add explicit SYSTEM, Administrators and Owner Rights ACEs that `/inheritance:r` keeps), so exactly one principal remains; applied before the
token is written; if icacls fails a warning is printed and install continues.

### Why `"command": "node"` and not the absolute node path

Matches architecture section 4.1 and survives Node upgrades and version managers (an absolute
`execPath` breaks the moment nvm or fnm switches versions, and every hook would then silently
fail). Claude Code's exec form resolves `node` from `PATH` (`node.exe` on Windows, never a `.cmd`
shim). The cost: if Claude Code is launched from an environment without Node on `PATH`, the hooks
fail quietly. If that happens, rerun install from a shell where `node -p process.execPath` is the
one you want and edit `command` to that path by hand.

## Uninstall

```
node packages/probe/dist/probe.mjs uninstall [--purge]
```

Removes only the probe's entries, restores a replaced `statusLine`/`subagentStatusLine`, and drops
arrays, the `hooks` object, or the whole file only where install created them. A 2-space file
returns to its original bytes. `probe.json` and the settings backups stay unless `--purge`, which deletes both (backups can hold
env secrets from settings.json). The spool is never deleted.

A replaced `statusLine`/`subagentStatusLine` is restored only if the recorded value deep-equals the
one in the backup taken at install; otherwise the key is removed and the backup path is printed.
`install-state.json` entries that do not fit the schema are ignored.

## Daemon

The daemon is the only networked part of the probe on the laptop. The hook appends one line to the
spool and exits; the daemon does the slow work:

- reads the spool in order, assigns `seq`, and POSTs batches (up to 200 envelopes or 250 ms) to the
  hub with exponential backoff capped at 30 s plus jitter; a batch is never dropped, and a restart
  resends nothing that was acknowledged;
- tails Claude Code transcripts (main and subagent) by byte offset, and resets on a replaced file;
- checks the Claude process of every session with `process.kill(pid, 0)` every 10 s (EPERM counts
  as alive) and reports `alive: false` when it is gone;
- sends a host heartbeat.

```
probe daemon run [--home <dir>] [--stderr]    # foreground, until Ctrl+C; a second copy for the same home exits 0
probe daemon install [--home <dir>] [--no-start]
probe daemon uninstall [--home <dir>]
```

`probe install` does not register the daemon. It prints a one-line hint, because starting a
background process at every logon is a separate decision from adding hooks. Run
`probe daemon install` once when you want it.

### Liveness: known gaps and accepted degraded modes

- **Unreadable process table on Windows (accepted degraded mode).** If the registration-time
  process snapshot (PowerShell, 8 s timeout) fails, the pid is kept as a candidate and retried, one
  snapshot per 10 s tick, up to 6 times. Until a retry succeeds the session is not tracked, so a
  death in that window produces no `alive: false` envelope. Bound: after one failed first snapshot,
  tracking starts up to about 26 s after `SessionStart` (8 s timeout, up to 10 s to the tick, up to
  8 s for the retry snapshot), and up to about 70 s if all 6 retries are used. Once tracked, a death
  is caught within 11.5 s (10 s tick plus 1.5 s grace) by `kill(pid, 0)`, which does not use
  PowerShell, so the 15 s bound holds even on a loaded laptop. A table that stays unreadable for all
  retries leaves the session unconfirmed.
- **The retry only helps when the reported pid is claude itself** (exec-form hook install). With a
  shell-wrapped hook the shell has usually exited by the time of the retry, so the pid cannot be
  walked to claude.
- **A snapshot that overflows `maxBuffer` is not retried**; it recurs on every read.
- **macOS:** a `ps` timeout at registration is final (no retry). macOS is not a first-class target.

### Autostart

- **Windows**: a per-user Task Scheduler task named `SessionDeckProbeDaemon`. Trigger: at logon of the
  current user (`DOMAIN\user`). Principal: that user, interactive logon, run level Limited (not
  elevated); no password is stored and no admin rights are needed by design. Settings: no execution
  time limit, runs on battery. Task Scheduler only restarts a task that fails to start, so the
  restart is done by `launch-daemon.vbs` in the probe home: `wscript.exe` runs it, it starts
  `node daemon.mjs` with window style 0 and waits (the task shows as running while the daemon
  lives), and after a non-zero exit it starts the daemon again, waiting 5 s, then 10 s, doubling up
  to 60 s (reset after a run of 10 minutes or more). Exit 0 ends the launcher: that is a graceful
  stop, or another daemon already holding the lock for this home, so there is no tight loop.
  Install first lists the tasks (locale-independent), and only touches a task of that name when its
  definition is ours (Description and launcher path); a foreign task of the same name is refused
  with exit 1, for install and for uninstall. When our task is already registered, install ends the
  running instance, rewrites the launcher and the task, and starts it. It runs
  `schtasks.exe /Create /TN SessionDeckProbeDaemon /XML <file> /F` (so installing twice leaves one
  task) and then `/Run`; uninstall runs `/End` and `/Delete /F`, and succeeds when the task is absent
  (any other query failure, such as access denied, exits 1 and keeps the launcher).
  `/End` stops the launcher (wscript) but not necessarily the `node.exe` it started, which would keep
  the daemon lock. So after `/End`, reinstall and uninstall stop the daemon itself: they read the
  newest `daemon\daemon.lock[.N]` under the probe home for the pid, act only when that file was
  touched in the last 60 s (a live daemon touches it every 10 s, so a stale file with a reused pid is
  ignored) and `tasklist` shows the pid as `node.exe`, then run `taskkill /PID <pid> /F` and wait up to
  10 s for it to go. The daemon keeps its state in atomic files and the next daemon judges the dead
  pid's lock stale, so a forced stop loses nothing. If the daemon will not stop, reinstall exits 1
  before writing anything; uninstall reports it and still removes the task. (The launcher keeps
  treating exit 0 as "stop", including lock contention; the stop-the-daemon step is what prevents a
  second launcher from meeting a live old daemon.) The schtasks, wscript, tasklist and taskkill
  paths are fixed at `C:\Windows\System32` and the Windows directory is never taken from the
  environment: a `SystemRoot`, `SYSTEMROOT` or `windir` that names anything else (a Windows
  installed on `D:\Windows`, or a planted value) is refused with a message saying so, and
  `probe daemon run` remains available there. On Windows `--home` must be the default probe home or a
  folder beneath it, for install and for uninstall (the launcher runs at every logon and no ACL is
  set elsewhere); the user's home is `os.homedir()` (`USERPROFILE`), the same source the hooks and the
  default probe home use. Paths containing `%` are refused. On Linux an existing `--home` must be
  owned by you and not group or world writable. Files are written to a fresh temp name and renamed
  over the target (mode 0600), never through a symlink; the temp file is removed if the write fails.
  Check the task:
  ```
  schtasks /Query /TN SessionDeckProbeDaemon /V /FO LIST
  Get-ScheduledTask -TaskName SessionDeckProbeDaemon | Get-ScheduledTaskInfo
  schtasks /Query /TN SessionDeckProbeDaemon /XML
  ```
  The task definition lives in the Task Scheduler store; everything else the daemon and installer
  write is under `%LOCALAPPDATA%\sessiondeck`. The task points at the absolute `node.exe` and
  `dist\daemon.mjs` it was installed from: after moving the repo or changing Node, run
  `probe daemon install` again.
- **Linux**: a systemd user unit `~/.config/systemd/user/sessiondeck-probe.service`
  (`Restart=on-failure`, `ExecStart` with absolute, quoted node and script paths). Install writes it,
  then `systemctl --user daemon-reload` and `enable --now`; uninstall does `disable --now`, removes
  the file and reloads. No root. Without a user bus (containers, ssh without a session) install
  still writes the unit, prints how to start it, and exits 0. Check it:
  ```
  systemctl --user status sessiondeck-probe.service
  journalctl --user -u sessiondeck-probe.service
  ```
- **macOS**: not supported yet; the commands print that and exit non-zero. Use `probe daemon run`.

### Daemon state and logs

Everything is under the probe home (Windows `%LOCALAPPDATA%\sessiondeck`, Linux and WSL2
`~/.local/state/sessiondeck`, or the `--home` it was started with), in `daemon/`:

| File                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `daemon.log`          | the daemon's log (rotated once at 5 MiB to `daemon.log.1`); read this first |
| `daemon.lock`         | one daemon per home                                                  |
| `state.json`          | spool cursor, next `seq`, the batch in flight (atomically replaced)  |
| `outbox/`             | envelopes the daemon itself produced (heartbeat, liveness, transcript) |
| `rejected/`           | batches the hub refused with a non-retryable 4xx (capped)            |
| `liveness.json`       | tracked Claude processes                                             |
| `transcript-offsets.json` | per-file byte offsets of the transcript tailer                   |

Hub URL, token and host come from `probe.json`; the daemon sends nothing until they are set, and
refuses an `http://` hub that is not loopback unless `allowInsecureHub` is true.

### Which transcripts are tailed

The daemon tails only transcript files whose real path is under
`<CLAUDE_CONFIG_DIR or ~/.claude>/projects`, as seen by the daemon's own environment (D-S2-10).
Paths from the spool (`transcript_path`, `agent_transcript_path`) are checked against that root and
never used to pick one. A session started with a different `CLAUDE_CONFIG_DIR` than the daemon's is
refused and logged, not tailed. If you use a non-default config directory, start the daemon with the
same `CLAUDE_CONFIG_DIR`. For the scheduled task or unit, that means setting it in your user
environment (Windows: `setx CLAUDE_CONFIG_DIR <dir>`, then log on again) so the daemon sees it.

## Where files live

Probe home: Windows `<user profile>\AppData\Local\sessiondeck` (neither the CLI nor the hook reads `LOCALAPPDATA`; the profile comes from `os.homedir()`, which reads `USERPROFILE` on Windows and `HOME` elsewhere: an accepted residual for a hook entry without `--home`, since install always writes `--home`); Linux and WSL2 `~/.local/state/sessiondeck`.
`probe install` records the resolved path in the hook arguments (`--home`). Only an explicit `--home <dir>`
moves it; no environment variable does (a repo's `.claude/settings.json` can set env). Install
prints the resolved home, refuses a default home inside a git work tree (pass `--home` to
override), and refuses to run (install, uninstall, config show) when `CLAUDECODE` is set unless `--allow-inside-claude`. Without `--home`, uninstall takes the home from the `--home` argument of the installed hook entries (it must be absolute). That inferred home is trusted for `--purge` only when an install record for this settings file exists there, and when it is inside a git work tree (and is not the default home) without such a record, uninstall refuses (pass `--home`). Uninstall also warns when our entries exist but no install record is found, and in that case writes its settings backup to the CLI default home, not the inferred one. Settings backups and `install-state.json` get no ACL of their own on Windows: they rely on the inheritance of the probe home directory (`%USERPROFILE%\AppData\Local` is user-only by default); only `probe.json` (the token) is explicitly restricted. Paths unsafe in a shell command (non-ASCII, quotes, `%`, `$`) skip only `statusLine`/`subagentStatusLine` with a notice; the hooks, which are argv, still install. If our `statusLine` from an earlier install is present, the skip removes it (it points at the previous dist path) and keeps the recorded previous value for a later install or uninstall; uninstall restores a verified recorded value even when our entry is already gone. Paths are written as `realpath.native` spellings with forward slashes (Windows 8.3 short names such as `C:\Users\RUNNER~1` and symlinks are expanded; a not-yet-created home is resolved through its deepest existing ancestor). A `~` is allowed in the middle of a path word (shells expand it only at the start of a word, and an absolute path starts with a drive letter or `/`); a word that starts with `~` is refused. Backups named in `install-state.json` are trusted only as `settings.backup-*.json` regular files directly in the probe home. On Windows `whoami.exe` and `icacls.exe` are run from `<SystemRoot>\System32` and the SID must be a per-user `S-1-5-21-...` (local or domain) or `S-1-12-1-...` (Entra ID) SID; well-known group SIDs are refused. Accepted residual: `SystemRoot` from the environment selects which `System32` those executables (and `chcp.com`) run from; it must be an absolute drive path, and it gives someone who can already set the probe's environment nothing beyond running code as the same user. WSL2 has its own home inside the
distro; install there separately. Directories are created `0700` and files `0600` on POSIX (the
spool holds raw prompts and tool inputs); the hook opens day files with `O_NOFOLLOW` (lstat on
Windows) and refuses anything that is not a regular file.

| File                        | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `probe.json`                | hub URL, token, host (user-only)                                       |
| `install-state.json`        | what install changed, per settings file, for exact uninstall           |
| `settings.backup-<ts>.json` | copy of settings.json taken before a write (0600, created exclusively) |
| `spool/<yyyy-mm-dd>.jsonl`  | one spool line per hook call, day file by UTC date                     |
| `hook-errors.log`           | hook failures (the hook itself never prints or fails)                  |

## The spool format

A spool line is a contract Envelope **without `seq`** (`SpoolLine`, `src/spool.ts`, with
`parseSpoolLine`). The hook takes no lock and keeps no counter: it appends each line with one
write on an `O_APPEND` descriptor, and every line is under 64 KB, so concurrent hooks cannot
interleave inside a line. A line over the cap has its payload replaced by
`{"truncated":true,"original_bytes":N,"limit_bytes":65536}`; `session_id`, `hook_event_name` and
`agent_id` longer than 256 characters make the hook drop the event (reason `id-too-long` in
`hook-errors.log`). The daemon (S2) is the single reader: it assigns `seq` in file order and
persists it with its cursor, so seq has no gaps or duplicates. The daemon ignores anything in
the spool directory that is not `*.jsonl`.

On `SessionStart` the hook also appends a `liveness` line `{pid, alive: true}` where `pid` is the
hook's parent process. Normally that is `claude`, but a node shim (Volta, a version manager) can
sit in between, so the daemon must confirm the pid against `~/.claude/sessions/*.json` before
trusting it.

## Reading the spool by hand

One SpoolLine (JSON) per line; there is no `seq` field.

PowerShell:

```
Get-Content "$env:LOCALAPPDATA\sessiondeck\spool\2026-10-20.jsonl" -Tail 5
Get-Content "$env:LOCALAPPDATA\sessiondeck\spool\2026-10-20.jsonl" -Tail 5 | ForEach-Object { $_ | ConvertFrom-Json } | Format-List
```

Linux and WSL2:

```
tail -n 5 ~/.local/state/sessiondeck/spool/$(date -u +%F).jsonl | jq .
tail -n 5 ~/.local/state/sessiondeck/spool/$(date -u +%F).jsonl | jq -r '[.ts,.kind,.hook_event_name] | @tsv'
```

## Statusline and subagent rows

`dist/statusline.mjs` is the `statusLine` command. It reads bounded stdin (8 MB, 2 s), appends one
`statusline` line to the spool FIRST (Claude Code cancels an in-flight script when a new tick
starts), then prints exactly one line and exits 0. It never prints a stack trace. Missing or
malformed stdin prints the fallback line `sessiondeck`, never a blank bar. Failures are logged to
`hook-errors.log` (reason only, prefixed `statusline`).

Format: `<state> | <model> [effort] | ctx 38% | 5h 78% | 7d 35% [| $1.23]`

- Model is `model.display_name` (else `model.id`), control characters stripped, 40 chars max.
  Effort level and `cost.total_cost_usd` are shown when present. Model text is cut by code point;
  escape sequences, control, bidi and zero-width characters are removed.
- `<state>` is not in the payload. The entry reads at most the last 64 KB of today's spool day file
  (UTC) and replays the `hook` lines whose `session_id` equals the payload's, in order, through
  `stepState()` in `src/statusline/state.ts`, a port of the contract's `reduce()` for the state field
  (it tracks the last main-thread tool, so Stop after AskUserQuestion or ExitPlanMode gives
  `waiting_input`, and the open permission holder; PostCompact only reopens a starting or working
  session). `test/statusline.test.ts` replays every sequence of up to three event variants (main
  thread and subagent) through the contract's `reduce()` and compares. When today's lines leave the
  state undecided, yesterday's file is read, but only if today's file is absent or was read whole
  (a file larger than the tail has earlier lines we did not see). No line, or any read error: `n/a`.
  The day file is never followed through a symlink, must be a regular file, and is opened with
  `O_NONBLOCK` (a FIFO planted at that name cannot block `open()`; on Windows the file is `lstat`ed
  first). The hub remains the authority; this is a local hint.
- `ctx` is `context_window.used_percentage` when it is 0..100, else computed from `current_usage`
  tokens over `context_window_size`, else `n/a`.
- `5h` and `7d` come from `rate_limits`. A window is `n/a` when the percentage is outside 0..100
  (Claude Code bug #52326) or `resets_at` (epoch seconds) is in the past (stale). No
  `rate_limits` at all (API-key plan) gives `5h n/a | 7d n/a`.
- Plain ASCII separators, no ANSI.

On Windows, only when the line contains non-ASCII and `MSYSTEM` is unset (Git Bash passes bytes
through), the entry runs `chcp.com 65001` so PowerShell decodes the output as UTF-8. Claude Code
runs the statusLine with the project directory as cwd, and Windows searches the cwd before PATH, so
the command is never resolved by name: it is `<SystemRoot>\System32\chcp.com` (SystemRoot from the
environment only if it is an absolute drive path, else `C:\Windows`), checked to be an existing
file, run with cwd System32, a 1 s timeout, a hidden window, ignored stdio and an environment of
only `SystemRoot`. Failures are ignored. Ported from ccstatusline (see `src/win-utf8.ts`). No
snapshot file is written, so no atomic-write helper is needed.

`dist/subagents.mjs` is the `subagentStatusLine` command: it appends one `subagents` line (the
whole payload including `tasks`) and prints nothing, so Claude Code keeps its default rows. Exit 0
under any input.

Latency (informational, `node packages/probe/scripts/bench-statusline.mjs`, 100 runs, Linux/WSL2,
no chcp). Before the state lookup, empty spool: p50 72.9 ms, p95 90.8 ms. After, spool day file
pre-filled with 70 KB of non-matching lines (worst case for the 64 KB tail read): p50 76.3 ms, p95
95.5 ms. On Windows a non-ASCII line adds one `chcp.com` spawn (at most 1 s, normally a few ms).
