# Sprint containers

A sprint container runs one mini-sprint orchestrator headless: it clones the repository into a volume, checks out the sprint branch, and runs the level-1 prompt with Claude Code while writing status and logs to `.sprint/<id>/` on the laptop. `CONDUCTOR.md` and `MINI-SPRINT-ORDER.md` decide what to start; the PowerShell scripts in `scripts/sprint/` start, watch and stop it. S0c built this tooling. This file was the specification; it is now the documentation, and the files listed below are the implementation.

Read the security note before the setup steps. The container is not a sandbox.

## Files

| File | What it is |
|------|------------|
| `infra/sprint/Dockerfile` | The image: node 22 pinned by digest, pnpm, git, gh, docker CLI and compose plugin, Claude Code CLI (pinned version), Playwright system libraries, a non-root user `sprint` (uid 1000) |
| `infra/sprint/docker-compose.yml` | Service `sprint`: image, `env_file`, pinned environment, the three mounts (work volume, state directory, docker socket) |
| `infra/sprint/entrypoint-precheck.sh` | Stage 1 of the entrypoint (POSIX sh, run by dash): environment allow-list, then execs stage 2 |
| `infra/sprint/entrypoint.sh` | Stage 2 (bash): drops root, clones or fetches, checks out the branch, runs `claude -p`, redacts and logs output, forwards SIGTERM |
| `infra/sprint/.dockerignore` | Build context holds only the two entrypoint files, so no env file can enter a layer |
| `infra/sprint/test/check-sprint-image.sh` | Container harness: builds the image and runs 10 checks with placeholder tokens |
| `infra/sprint/test/docker-compose.test.yml` | Test-only compose override used by the harness to put the stub ahead of the real `claude` |
| `infra/sprint/test/claude-stub.sh` | Test-only stand-in for `claude`; records argv and facts, writes the smoke status file |
| `scripts/sprint/run-sprint.ps1` | Renders the prompt, creates `.sprint/<id>/`, starts the container detached as `sprint-<id>` |
| `scripts/sprint/status.ps1` | Prints every `.sprint/*/status.json` (and session files) as tables; read-only |
| `scripts/sprint/stop-sprint.ps1` | Stops and removes `sprint-<id>` and sibling `sd-<id>-*` containers; keeps the volume and `.sprint/<id>/` |
| `scripts/sprint/smoke-check.ps1` | The Sprint 0 smoke gate in one command: starts `smoke`, waits for green, prints one evidence block, stops it |
| `scripts/sprint/render-prompt.mjs` | Prompt renderer used by `run-sprint.ps1` (documented in `scripts/README.md`) |
| `scripts/sprint/lib/sprint-common.ps1` | Exit codes, id and image patterns, path and environment helpers |
| `scripts/sprint/lib/sprint-docker.ps1` | Docker queries (container names, image summary) and the checks that the docker target is local (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `docker context show`) |
| `scripts/sprint/lib/sprint-envfile.ps1` | Warns about extra readers of the env file; reads permissions only, never the content |
| `scripts/sprint/lib/sprint-repourl.ps1` | Clone URL rules (github.com HTTPS only, must match origin) |
| `scripts/sprint/lib/sprint-sanitize.ps1` | Reduces text from state files to printable ASCII for `status.ps1` |

## Security note (read first)

### The docker socket and the container

- The container mounts `/var/run/docker.sock`. Whoever holds that socket is root-equivalent on the host (or on the Docker Desktop VM). A session can run `docker exec -u 0` into any container, or `docker run --privileged -v /:/host`.
- Through Docker Desktop file sharing, a session can then read and write the Windows user profile: `.sprint/env`, Claude credentials, `probe.json` and the user-level settings file. A hook added to the user-level settings file is code execution on the laptop.
- `docker inspect` shows every container's environment, so it shows the tokens.
- So the container is not a sandbox. Sessions run with `--dangerously-skip-permissions`. With the socket, a prompt-injected sprint session has the user's full laptop privileges and nobody is watching. The project deny rules and `guard.mjs` do not cover actions taken through Docker.
- The non-root user `sprint` (uid 1000) gets the socket's group. On Docker Desktop that group is group 0. The user exists only because Claude Code refuses `--dangerously-skip-permissions` as root. It is not a security boundary.
- `setpriv` with `no_new_privs` and dropped capabilities only stops escalation inside the container. It cannot stop a request to the Docker daemon, which starts processes outside the container.
- Any process that can run docker can read the tokens without opening `.sprint/env`: `docker run --env-file .sprint/env <image> env`. A deny rule on reading the file does not protect it.

Alternatives, with their cost (none is built; each is a change to this tooling):

| Alternative | What it gives | Cost |
|-------------|---------------|------|
| Socket proxy in front of the socket | Refuses binds, `--privileged`, exec and host namespaces | An extra service to run; calls it refuses stop working for sessions |
| Docker Desktop Enhanced Container Isolation | Stronger isolation of containers from the VM | Docker Desktop feature; not tested here |
| Rootless docker-in-docker | Sessions get their own daemon with no access to the host daemon | A different container setup; sibling containers would live in that inner daemon. Not tested here |

The user must decide which of these to adopt, or to accept the risk, before the first real sprint. This document does not decide it. The cost column was not measured in S0c.

### Tokens

- Tokens enter only through `.sprint/env`, read by compose `env_file`. They are never build args, never interpolated in the compose file, never on a command line.
- `run-sprint.ps1` checks that the file exists and reads its permissions (ACL). It never opens, prints, hashes or copies its content. It warns about extra readers; it does not refuse to start.
- Every process in the container can read both tokens from its environment.
- `docker compose config` against the real env file prints both tokens. Never run it in a session, and never paste its output.
- Never add `infra/sprint/docker-compose.override.yml` (compose merges that name into any run without `-f`) or `infra/sprint/.env` (compose reads it for interpolation and it could switch the image). `run-sprint.ps1` exits 3 if `infra/sprint/.env` exists and always sets `SPRINT_IMAGE` itself.
- Compose sends the env file values to whatever daemon the docker target names. `run-sprint.ps1` exits 3 if `DOCKER_HOST` is set, if `DOCKER_CONFIG` is set (another config directory can name any context), if `DOCKER_CONTEXT` is anything other than `default` or `desktop-linux`, or if `docker context show` (the context saved by `docker context use`) prints anything other than `default` or `desktop-linux`. It names the variable, never the value, and never prints a context name. After `docker context use hub-box`, run `docker context use default` (or `desktop-linux`) before starting a sprint. `stop-sprint.ps1` does not check this (it sends no tokens).
- Git sends `GH_TOKEN` only to `https://github.com`, through a credential helper that reads the environment at use time. The token is not written to `~/.gitconfig`, `/work/.git/config` or a URL.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are refused on purpose. They rank above `CLAUDE_CODE_OAUTH_TOKEN`, so setting either would bill the API account instead of the subscription.
- Scope `GH_TOKEN` to this one repository (step 2 below). Know how to revoke both tokens quickly. How to delete a GitHub token was not checked against GitHub's documentation in S0c: find the steps on GitHub before you need them. Revoking a Claude token is not documented (see step 1).

### The environment allow-list

- Stage 1 (`entrypoint-precheck.sh`) runs under dash before bash starts. Bash would source `BASH_ENV` and import exported `BASH_FUNC_*` functions before the first line of any bash script, so a check written in bash cannot stop them.
- Accepted names: `SPRINT_*`, the two tokens, a few ordinary container names (`DEBIAN_FRONTEND`, `HOSTNAME`, `TERM`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `NODE_VERSION`, `YARN_VERSION`), and the pinned names below. Any other name makes the container exit 64 with the variable name (never its value) in the message.
- `BASH_ENV`, `LD_PRELOAD`, `LD_AUDIT` and `LD_LIBRARY_PATH` are accepted only when empty. Compose pins all four to empty. Every other `LD_*` name and every `BASH_FUNC_*` name is refused.
- `HOME`, `PATH`, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`, `GIT_TERMINAL_PROMPT` and `GH_PROMPT_DISABLED` must equal the image values.
- Any entry whose value contains a newline is refused, so a newline cannot hide the rest of a variable from the check.
- The dynamic loader acts on any `LD_*` name before the pre-stage can look. So compose pins the known code-loading ones, and the pre-stage refuses the rest. A plain `docker run` without the compose file pins nothing: the protection there rests on the pre-stage alone. Always start sprints through `run-sprint.ps1` and compose.
- What the list is for: configuration mistakes and accidental overrides (a proxy variable, a Bedrock switch, a stray `ANTHROPIC_*` name). What it is not for: it is not a defense against someone who can write `.sprint/env`, because that person already holds both tokens. Put nothing in `.sprint/env` except the two tokens.
- `--entrypoint` or `docker exec` skip stage 1. Anyone who can do that already controls the container.

### Logs, redaction and untrusted files

- Redaction replaces the exact values of the two tokens in claude's stdout and stderr (`sprint.jsonl` and `docker logs`) with `[REDACTED]`. A token that JSON escaping would change, an encoded token or a partial token is not matched.
- Files a session writes under `.sprint/<id>/`, and transcripts inside the container, are not filtered. Treat `.sprint/<id>/`, `entrypoint.log`, `docker logs`, `docker inspect` and `docker cp` output as secret.
- The state directory is writable by the container, so `status.json`, `sessions/*.json`, `questions.md` and reports are untrusted input. `status.ps1` cuts every value, reduces it to printable ASCII, maps states to the schema words (anything else shows as `invalid`), and skips files over 256 KiB (`too large`). Opened any other way, the raw files and `questions.md` can still carry prompt injection and terminal escape sequences.
- The work volume `sprint-<id>-work` survives `stop-sprint.ps1`, and every start reuses it, with or without `-Resume`: the entrypoint takes the fetch path whenever `/work/.git` exists. `-Resume` also reuses the state directory. Treat both as tainted after any run you suspect: git config and hooks in `/work/.git` run on the next fetch or checkout, and a previous run can leave files (for example a shared library) that a later run loads. Stopping the sprint does not clean this up. For a fresh clone, stop the sprint, then run `docker volume rm sprint-<id>-work` (for the smoke sprint: `docker volume rm sprint-smoke-work`); the next start clones again. Remove or move `.sprint/<id>/` too if the state directory is suspect.
- `run-sprint.ps1` accepts only `https://github.com/<owner>/<repo>` clone URLs, and the owner and repository must match the origin remote (compared case-insensitively against the origin URL text). `-AllowForeignRepo` lifts only the origin match, never the github.com rule. A foreign repository's `CLAUDE.md`, hooks and agents run with both tokens. The default trusts the repository's `.git/config`, so a local session that rewrites origin changes what gets cloned.
- `-Image` names the image that receives both tokens. By default only `sessiondeck-sprint:<tag>` is accepted. Anything else needs `-AllowForeignImage`, and then only for an image you built yourself.
- Sprint ids: letters, digits and underscore, starting with a letter or digit (no hyphen). Sibling containers are matched by the prefix `sd-<id>-`, so an id that is a prefix of another followed by a hyphen would claim its containers. The id rule prevents that. `stop-sprint.ps1` stops `sprint-<id>` (exact name) and every container whose name starts with `sd-<id>-`. Stopping sprint 0 therefore also removes the `sd-0-*` containers that local sessions started.

## One-time setup (on the laptop)

1. Create the Claude token. In a normal terminal (not inside a Claude Code session) run `claude setup-token`. It is interactive and opens the same browser sign-in as `/login`. It prints the token and saves nothing, so copy it when it appears. It needs a Pro, Max, Team or Enterprise plan. The token lasts one year: set a calendar reminder before it ends. Replacing an expired token is documented. Revoking a token is not documented, so there is no verified way to cancel one early; keep it out of every log and file.
2. Create the GitHub token. Use a fine-grained personal access token with these settings. These details came through a summarizer; check the token page when you create it.
   - Resource owner: the account that owns the repository, `stack-dev-personal` (`emstacho-su/sessiondeck` redirects to it).
   - Repository access: only this repository.
   - Permissions: Contents read and write; Pull requests read and write; Actions read; Commit statuses read; Metadata read (added automatically).
   - Checks cannot be granted to a fine-grained token, so `gh pr checks` may not work with it. `gh run list` needs only Actions read.
   - Workflows write is needed only if a sprint pushes changes under `.github/workflows/`. That requirement is community-sourced, not from GitHub's own documentation.
   - Expiry: the maximum is 366 days. Set a reminder for this one too.
3. Write `.sprint/env` at the repository root of the main checkout. Exactly two lines, nothing else (the container refuses any other variable name):

   ```
   CLAUDE_CODE_OAUTH_TOKEN=<paste token here>
   GH_TOKEN=<paste token here>
   ```

   `.sprint/` is gitignored. Never commit this file or paste it anywhere.
4. Restrict the file. Mode 600 has no effect on NTFS, so use `icacls` in PowerShell, from the repository root:

   ```
   icacls .sprint\env /inheritance:r
   icacls .sprint\env /grant:r "$($env:USERNAME):(R,W)"
   icacls .sprint\env
   ```

   The last command should list only your account. (Run on a scratch file on 2026-10-14, it printed one entry for the current user.) On Linux or macOS use `chmod 600 .sprint/env`; on a Linux host `.sprint/<id>` must also be writable by uid 1000.
5. Build the image once. Either run the harness (see Testing), or run `scripts/sprint/run-sprint.ps1 -Sprint smoke -Build`, which builds before it starts. A build takes about 10 minutes.
6. Run the smoke test (next section).

## Smoke test (Sprint 0 gate)

Status: the laptop confirmation is still pending for S0c. No tokens existed during S0c, so the smoke run has not happened with real credentials. The harness runs the same path with a stub `claude` and placeholder tokens.

One command does steps 1 to 4 below and prints the evidence: `scripts/sprint/smoke-check.ps1` (optional `-EnvFile`, `-StateRoot`, `-RepoRoot`, `-TimeoutSeconds 120`, `-PollSeconds 3`, `-KeepContainer`, `-EvidenceFile <path>`). It deletes a previous `smoke/status.json` (that one file; it never uses `-Resume`, because a stale green file would be a false pass), runs `run-sprint.ps1 -Sprint smoke`, polls the status file until it is green, the container exits or the timeout passes, then runs `stop-sprint.ps1 -Sprint smoke`. The timeout counts from the moment `run-sprint` returns, so an image build (about 10 minutes when `sessiondeck-sprint:local` is missing) does not eat the two minutes; the script asks docker first and the evidence says when the image was missing and a build happened. `stop-sprint` is skipped with `-KeepContainer`, and also after `run-sprint` exit 1, 2, 3 or 4 (nothing of this run was started, and after exit 4 the running container is not this run's, so stopping it would be wrong). It still runs after exit 5, because compose may have left a half-started container. The evidence block has PASS or FAIL, `start_seconds` (the time `run-sprint` took) and `wait_seconds` (against the limit), the image line, the final state, the container exit code, the last 20 lines of `entrypoint.log` as printable ASCII, and a secrets reminder; it never prints docker logs or the env file. Exit codes: 0 PASS; 1 FAIL (timeout, container exited, state not green, or an unexpected error inside `run-sprint`); 2, 3, 4 or 5 when `run-sprint` itself failed (same meaning as below). Attach the block (read it first) to the S0c confirmation.

The manual steps:

1. `scripts/sprint/run-sprint.ps1 -Sprint smoke`
2. Within two minutes `.sprint/smoke/status.json` should exist with state `green`. Check with `scripts/sprint/status.ps1`. The smoke prompt asks the session to write `/state/smoke/status.json` with state green and exit. A pass proves auth, the repository step (a clone on the first run; a fetch on every later run, because the work volume is kept), the state mount and the socket mount. To prove a clone again, stop the sprint and run `docker volume rm sprint-smoke-work` first. Treat the volume as tainted after any suspect run.
3. On failure look at `.sprint/smoke/logs/entrypoint.log` and `docker logs sprint-smoke`. Both may hold secrets: do not paste them.
4. `scripts/sprint/stop-sprint.ps1 -Sprint smoke`

Observed on Claude Code 2.1.295 in the image (2026-10-14, no credentials): as root, `--dangerously-skip-permissions` is refused with "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons". As the non-root user, `claude -p` exits 1 without hanging or onboarding, with the result "Not logged in - Please run /login" (the real text has a middle dot, not a hyphen). So a missing token shows up as exit 1 and that message in `sprint.jsonl`. Not observed: what a rejected or expired token prints. It may be different text (the harness also accepts an `authentication_failed` error), so do not rely on finding "Not logged in" in that case.

Not verified: `--agent` together with `-p` and a project-scoped agent is not documented either way, so the first real sprint is also its confirmation.

## Container contract

| Path in container | Host | Purpose |
|-------------------|------|---------|
| `/work` | named volume `sprint-<id>-work` | clone of the repo, made on the first start; kept by `stop-sprint.ps1` and reused by every later start (fetch path); worktrees under `/work/wt/<session>`. `docker volume rm sprint-<id>-work` after stopping gives a fresh clone |
| `/state/<id>` | bind mount `.sprint/<id>/` | status, prompts, questions, answers, logs, reports, screens, gate (PROMPT-BOOK section 6) |
| `/var/run/docker.sock` | host socket | lets executors start sibling test containers named `sd-<sprint>-<session>-*`, removed at session end. Root-equivalent: see the security note |

Compose project and container name: `sprint-<id>`. The container's working directory is `/work`.

Environment:

| Variable | Source | Purpose |
|----------|--------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | `.sprint/env` | Claude auth for headless sessions on a subscription |
| `GH_TOKEN` | `.sprint/env` | push branches, open PRs, read checks |
| `SPRINT_ID`, `SPRINT_BRANCH`, `SPRINT_REPO_URL` | set by `run-sprint.ps1` through compose | which package, which branch, which repository |
| `BASH_ENV`, `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH` | compose, pinned to empty | block code-loading hooks |
| `DISABLE_AUTOUPDATER=1`, `CLAUDE_CONFIG_DIR=/home/sprint/.claude`, `HOME=/home/sprint`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `PATH` | image and compose, same values | pinned versions, no prompts |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` | set by `entrypoint.sh` stage 2 | see below |

Compose also reads `SPRINT_IMAGE`, `SPRINT_ENV_FILE` and `SPRINT_STATE_ROOT` (set by `run-sprint.ps1`). No SSH keys, no Cloudflare, no Supabase, no probe tokens. Sprint 4's box work runs from the conductor session on the laptop.

Versions are build arguments in the `Dockerfile`: Claude Code `2.1.295`, pnpm (must equal the root `packageManager` field; a static test enforces it), Playwright `1.56.1` (used only to install browser system libraries). The Claude Code package is installed with `DISABLE_AUTOUPDATER=1` so the pinned version stays.

### Two-stage entrypoint

1. `entrypoint-precheck.sh` (dash, as root) runs the allow-list and execs the bash entrypoint. Exit 64 means a refused environment.
2. `entrypoint.sh` starts as root only to read the socket's group id, `chown` the top of `/work`, and re-exec itself as `sprint` through `setpriv` (no new privileges, no capabilities). It checks that `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset, that both tokens, `SPRINT_ID` and `SPRINT_REPO_URL` are set, that the id matches the script rule, and that the repository URL carries no credentials. Then it sets up git, clones (or fetches when `/work/.git` exists), checks out the sprint branch (or the default branch if the sprint branch is not on the remote), and runs claude. Log lines go to `/state/<id>/logs/entrypoint.log` and stderr; they name the tokens but never print values.

### Headless invocation

```
claude -p "$(cat /state/$SPRINT_ID/sprint-prompt.md)" --agent sd-sprint-orchestrator \
  --dangerously-skip-permissions --output-format stream-json --verbose
```

`entrypoint.sh` runs this in the background with its output passed through the redaction filter and `tee`d to `/state/<id>/logs/sprint.jsonl`. Phase managers inside are launched by the orchestrator with the command in `PROMPT-BOOK.md` section 2. The project deny rules and `guard.mjs` still run inside, but see the security note: the container is not the sandbox.

`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: headless `claude -p` stops background tasks ten minutes after the main turn goes idle and then exits. That ended a real orchestrator run that was waiting on background subagents. Zero removes the ceiling. Sessions should still keep subagent calls in the foreground.

### SIGTERM and exit codes

`docker stop` sends SIGTERM to PID 1. The entrypoint installs its handler before the clone and forwards the signal to claude. If the stop arrives before claude starts, the container exits 143 without launching it. During a foreground git step the stop waits until that step ends. Docker kills the container after its stop timeout (10 seconds by default). Container exit codes: claude's own status; 64 configuration refused; 143 stopped; and the status of a failed setup step, because the script runs under `set -e`: a failed clone, fetch or checkout exits with git's own status (for example 128). A failed step also leaves a line in `entrypoint.log` with the step name and a fixed hint (clone or fetch: check that `GH_TOKEN` has access to this repository, `SPRINT_REPO_URL` and the network; checkout: check `SPRINT_BRANCH`). git's own error text is not copied there; it is only in `docker logs`, which are secret.

### Resume

`run-sprint.ps1 -Sprint <id> -Resume` starts a new container (compose `--force-recreate`) against the same `.sprint/<id>/`, the existing work volume (fetch path, not clone) and the remote sprint branch. A plain start also reuses the work volume when it exists; `-Resume` differs in keeping the state directory and recreating the container. A local branch with unpushed commits is never discarded. The orchestrator's setup step detects the branch and status file and continues from them; sessions with state green are not relaunched. Treat the volume as tainted (security note).

## Scripts reference

All four are written for Windows PowerShell 5.1 and PowerShell 7 (`pwsh`) and tested on Windows PowerShell 5.1 only; `pwsh` 7 has not been run. If scripts are blocked by the execution policy, set `RemoteSigned` for your user, or run one script with `powershell -ExecutionPolicy Bypass -File scripts/sprint/run-sprint.ps1 -Sprint smoke`.

Exit codes (shared):

| Code | Meaning |
|------|---------|
| 0 | `run-sprint`: started, or dry run ok. `stop-sprint`: stopped, or nothing to stop. `status`: always 0 once it reaches the table, including "nothing to show" |
| 2 | Bad input: sprint id, `-ContractSha`, `-Image`, repository URL, renderer usage error, or the package's `runs_in` is not `container` |
| 3 | Prerequisite missing (node, docker, env file, compose file, renderer), `infra/sprint/.env` exists, origin remote unreadable, renderer failure (other than a usage error, which is 2), or the docker target is not the local daemon: `DOCKER_HOST` set, `DOCKER_CONFIG` set, `DOCKER_CONTEXT` or the context from `docker context show` not `default` or `desktop-linux`, or `docker context show` failing. `stop-sprint`: docker missing |
| 4 | `run-sprint`: container already running, state conflict (`status.json` exists without `-Resume`, or `-Resume` without a state directory) |
| 5 | Docker failure, including any `docker image inspect` failure other than "No such image" |

`run-sprint.ps1` parameters:

| Parameter | Meaning |
|-----------|---------|
| `-Sprint <id>` | Package id from `MINI-SPRINT-ORDER.md`, or `smoke`. Letters, digits and underscore only |
| `-Resume` | Start against the existing `.sprint/<id>/`; keeps everything in it |
| `-ContractSha <sha>` | Contract commit on main; required for every sprint except 0 and smoke. Letters, digits and `. _ / -` |
| `-DryRun` | Do everything except the docker call that changes state; prints that call. It still writes the state directories and the prompt |
| `-EnvFile <path>` | Env file with the two tokens. Default: `<state root>/env`, that is `.sprint/env` |
| `-RepoRoot <dir>` | Repository root. Default: two levels above the script |
| `-StateRoot <dir>` | Directory holding one state directory per sprint. Default: `<repo>/.sprint` |
| `-RepoUrl <url>` | Clone URL. Default: the origin remote. Must be github.com HTTPS and match origin unless `-AllowForeignRepo` |
| `-AllowForeignRepo` | Accept a `-RepoUrl` that differs from origin (it runs that repository's config with both tokens) |
| `-Image <ref>` | Image to start. Default `sessiondeck-sprint:local`. Only `sessiondeck-sprint:<tag>` unless `-AllowForeignImage` |
| `-AllowForeignImage` | Accept another image reference (it receives both tokens) |
| `-Build` | Pass `--build` to compose. Without it compose builds only when the image is missing |

A sprint whose package has `runs_in` other than `container` (Sprint 0) is refused with exit 2 (with `-DryRun` it only warns). The script prints which image will run and when it was created.

`stop-sprint.ps1` parameters: `-Sprint <id>` (as given to `run-sprint.ps1`) and `-DryRun` (print the docker commands instead). It uses `docker stop` and `docker rm` (no volume flag, so the work volume survives), re-lists siblings after the stop and removes only those still present (a sibling started with `--rm` is already gone), treats docker's "No such container" and "removal ... already in progress" answers to `docker stop` or `docker rm` as done (a `--rm` container can vanish between the list and the call; any other docker error is exit 5 and docker's message is shown), and removes the leftover `sprint-<id>_default` network, also when there was nothing to stop.

`status.ps1` parameter: `-Root <dir>` (directory holding the state directories; default `<repo>/.sprint`). It prints one table of sprints (state, sessions, waiting, pr, updated_at, age in minutes) and one of sessions. A missing, partial or non-object file shows as `unreadable` or `no status.json` for that row. Sprint states: running, blocked, merging, gate, awaiting-merge-approval, merged, failed, green.

## Testing

- Static tests in the default suite (`pnpm -F @sessiondeck/scripts test`): `scripts/test/sprint-image-static.test.ts` checks the Dockerfile, compose file and entrypoint scripts (pinned versions, the allow-list logic, the compose pins, the secrets rules). The prompt renderer has its own tests.
- PowerShell script tests: `test:sprint-ps`, a separate CI step. They run the four scripts against a fake `docker` and need PowerShell. They were run on Windows PowerShell 5.1 only; `pwsh` 7 was not available in S0c.
- Container harness (needs Docker, builds the image, takes about 11 minutes):

  ```
  bash infra/sprint/test/check-sprint-image.sh <output-dir> --i-have-the-go
  ```

  - Gate: the harness exits 2 unless the user's go file exists (`.sprint/0/answers/S0c-u2-go.md` in the main checkout) or `--i-have-the-go` is passed, so it cannot start by accident.
  - In Git Bash the script sets `MSYS_NO_PATHCONV=1` itself. Do the same for any manual `docker` command with a path such as `/var/run/docker.sock` or `/state`, or Git Bash rewrites it into a Windows path.
  - It never reads or creates a real token and never touches `.sprint/env`. It uses placeholder tokens, a stub `claude`, compose project `sd-0-s0c-harness` and containers named `sd-0-S0c-*`, removes what it created and keeps the built image.
  - The 10 checks: image contents and pins; user, mounts and the docker socket with a sibling container; the argument list; real binary without credentials; secret hygiene in logs and config; the allow-list guards; second run (fetch path); shellcheck; SIGTERM handling.
  - Evidence: `C:/Users/stack/projects/sessiondeck/.sprint/0/screens/S0c/u2-container-check.txt`. Latest result: 103 PASS, 0 FAIL.

## Limits and known gaps

- Every headless session counts against the subscription's 5h and 7d windows. The conductor's `MAX_SPRINT_CONTAINERS` and each package's `max_parallel` are the throttle.
- Windows-only code (probe hook, runner pty) cannot be exercised in the Linux container; the windows-latest CI job and the conductor's laptop checks cover it.
- A container that loses network mid-session leaves the session's branch pushed up to its last commit; `-Resume` picks up from the session log and `docs/HANDOFF-*.md`.
- Deferred, with the reason it is acceptable for Phase 0 (local build, apt over TLS, the gh keyring checked against GitHub's published fingerprints, base image pinned by digest). Close these before building on the hub box or before Phase 8:
  - The Docker apt signing key is not fingerprint-checked.
  - The apt package versions (gh, docker-ce-cli, compose plugin) are not pinned, so a rebuild takes what the vendors currently ship.
  - The pre-stage is not run by a statically linked shell (busybox-static), which would ignore `LD_*` names. Compose pins plus the pre-stage refusal cover the known names instead.
  - A plain `docker run` without the compose file pins nothing.
- `.sprint/env` is not yet in the project deny rules or in `guard.mjs`. Until it is, a session can read it.
