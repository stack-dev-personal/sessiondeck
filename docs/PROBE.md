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
`probe install` registers the absolute path of the `dist/` it runs from, so install from the
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
any data is written). Windows: `icacls <file> /inheritance:r /grant:r <you>:F`, applied before the
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

## Where files live

Probe home: Windows `<user profile>\AppData\Local\sessiondeck` (neither the CLI nor the hook reads `LOCALAPPDATA`); Linux and WSL2 `~/.local/state/sessiondeck`.
`probe install` records the resolved path in the hook arguments (`--home`). Only an explicit `--home <dir>`
moves it; no environment variable does (a repo's `.claude/settings.json` can set env). Install
prints the resolved home, refuses a default home inside a git work tree (pass `--home` to
override), and refuses to run (install, uninstall, config show) when `CLAUDECODE` is set unless `--allow-inside-claude`. Without `--home`, uninstall takes the home from the `--home` argument of the installed hook entries (it must be absolute). That inferred home is trusted for `--purge` only when an install record for this settings file exists there, and when it is inside a git work tree (and is not the default home) without such a record, uninstall refuses (pass `--home`). Uninstall also warns when our entries exist but no install record is found. Paths unsafe in a shell command (non-ASCII, quotes, `%`, `$`) skip only `statusLine`/`subagentStatusLine` with a notice; the hooks, which are argv, still install. If our `statusLine` from an earlier install is present, the skip removes it (it points at the previous dist path) and keeps the recorded previous value for a later install or uninstall. Paths are written as `realpath.native` spellings with forward slashes (Windows 8.3 short names such as `C:\Users\RUNNER~1` and symlinks are expanded; a not-yet-created home is resolved through its deepest existing ancestor). A `~` is allowed in the middle of a path word (shells expand it only at the start of a word, and an absolute path starts with a drive letter or `/`); a word that starts with `~` is refused. Backups named in `install-state.json` are trusted only as `settings.backup-*.json` regular files directly in the probe home. On Windows `whoami.exe` and `icacls.exe` are run from `<SystemRoot>\System32` and the SID must be a per-user `S-1-5-21-...` (local or domain) or `S-1-12-1-...` (Entra ID) SID; well-known group SIDs are refused. Accepted residual: `SystemRoot` from the environment selects which `System32` those executables (and `chcp.com`) run from; it must be an absolute drive path, and it gives someone who can already set the probe's environment nothing beyond running code as the same user. WSL2 has its own home inside the
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
