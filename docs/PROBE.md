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

## Install

```
node packages/probe/dist/probe.mjs install --hub http://192.168.1.20:8787 --token-file C:/secrets/sd-token.txt
```

- Settings file: `$CLAUDE_CONFIG_DIR/settings.json` if `CLAUDE_CONFIG_DIR` is set, else the default
  Claude Code user settings file. `--settings <path>` overrides both. Run it from a plain terminal.
- Hooks: one exec-form group per event (17 events: SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied, Notification, SubagentStart,
  SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, PreCompact, PostCompact, SessionEnd),
  `"command": "node"`, `"args": ["<abs forward-slash path>/dist/hook.mjs", "--sessiondeck-probe"]`,
  `"timeout": 5`. The trailing `--sessiondeck-probe` argument is the marker that lets install and
  uninstall recognise the probe's own entries; the scripts ignore it.
- Existing hooks, matchers, `permissions`, `env` and every other key are left as they are. Our
  group is appended after yours (or, on a re-run, stays where it was). Re-running install changes
  nothing (byte-identical file, no new backup).
- `statusLine` and `subagentStatusLine` are set only if absent or already ours. If you have your
  own, install leaves it and prints a notice. `--statusline=replace` takes over; the previous value
  is saved in `install-state.json` and `uninstall` puts it back exactly.
- Before the first write the original is copied to `<probe home>/settings.backup-<timestamp>.json`.
  Writes are atomic (temp file, fsync, rename, with retry for Windows sharing violations).
- A settings file that is not valid JSON (or has a wrongly shaped `hooks`) is refused: non-zero
  exit, nothing changed.
- The file is re-serialized with its own indent and trailing-newline style. A file that was
  hand-aligned (for example inline arrays) is normalised to plain `JSON.stringify` layout once.

### Token and config

`probe.json` in the probe home holds `hubUrl`, `token`, `host` (default: this machine's hostname).
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
returns to its original bytes. `probe.json` stays unless `--purge`. The spool is never deleted.

## Where files live

Probe home: Windows `%LOCALAPPDATA%\sessiondeck`; Linux and WSL2 `$XDG_STATE_HOME/sessiondeck`,
default `~/.local/state/sessiondeck`. `SESSIONDECK_HOME` overrides. WSL2 has its own home inside
the distro; install there separately.

| File | Purpose |
|------|---------|
| `probe.json` | hub URL, token, host (user-only) |
| `install-state.json` | what install changed, per settings file, for exact uninstall |
| `settings.backup-<ts>.json` | copy of settings.json taken before a write |
| `spool/<yyyy-mm-dd>.jsonl` | one Envelope per line, day file by UTC date |
| `spool/.lock` | advisory append lock |
| `spool/.seq` | per-host sequence counter |
| `hook-errors.log` | hook failures (the hook itself never prints or fails) |

## Reading the spool by hand

One Envelope (JSON) per line.

PowerShell:

```
Get-Content "$env:LOCALAPPDATA\sessiondeck\spool\2026-10-20.jsonl" -Tail 5
Get-Content "$env:LOCALAPPDATA\sessiondeck\spool\2026-10-20.jsonl" -Tail 5 | ForEach-Object { $_ | ConvertFrom-Json } | Format-List
```

Linux and WSL2:

```
tail -n 5 ~/.local/state/sessiondeck/spool/$(date -u +%F).jsonl | jq .
tail -n 5 ~/.local/state/sessiondeck/spool/$(date -u +%F).jsonl | jq -r '[.seq,.kind,.hook_event_name] | @tsv'
```
