#!/usr/bin/env bash
# Sprint container entrypoint: clone or fetch the repo into /work, check out the
# sprint branch, run the level-1 prompt headless, tee the stream to /state.
# Specification: infra/sprint/README.md.
#
# Secret hygiene: this script never enables tracing, never dumps the
# environment, and only ever names a token variable, never prints its value.
set -euo pipefail

readonly SPRINT_USER=sprint
readonly DOCKER_SOCKET=/var/run/docker.sock
readonly WORK_DIR=/work
readonly STATE_ROOT=/state
readonly SPRINT_AGENT=sd-sprint-orchestrator
readonly EXIT_CONFIG=64

# Git asks this helper for credentials. The single quotes keep ${GH_TOKEN}
# literal here: it is expanded by git's shell at use time, from the environment,
# so the token is never written to ~/.gitconfig, /work/.git/config or a URL.
#
# The helper answers only "get"; for "store" and "erase" it does nothing and
# exits 0, so git never sees a failing helper.
# shellcheck disable=SC2016 # literal on purpose, see above
readonly CREDENTIAL_HELPER='!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=${GH_TOKEN}"; fi; }; f'

# Headless "claude -p" stops background tasks ten minutes after the main turn
# goes idle and then exits; that killed a real orchestrator run that was waiting
# on background subagents. Zero removes the ceiling so the orchestrator decides
# when it is done. Exported at top level so every claude process inherits it.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0

# --- Stage 1 (root only): make the docker socket usable, then drop for good ---
#
# Decision, made from inspecting a stock node container on this laptop's Docker
# Desktop 29.8.1: the mounted socket is owner 0, group 0, mode 660 (root:root),
# so a compose group_add of a fixed "docker" gid cannot work there; a Linux host
# shows root:docker with a gid that varies per machine, so a fixed number cannot
# work there either. Only a run-time lookup covers both.
# The socket's owner differs by host. On Docker Desktop it is root:root 660
# inside the container; on a Linux host it is root:docker (gid varies). Rather
# than chmod the socket or keep root, read its gid and hand that gid to the
# session user as a supplementary group, then re-exec this script unprivileged.
# setpriv drops the bounding set and sets no_new_privs, so neither the session
# nor anything it spawns can regain root. On Docker Desktop the gid is 0, so the
# session user also holds group root; that grants nothing beyond the socket,
# which is already root-equivalent on the VM and is the point of mounting it.
if [ "$(id -u)" -eq 0 ]; then
  groups_arg="--clear-groups"
  if [ -S "$DOCKER_SOCKET" ]; then
    groups_arg="--groups=$(stat -c %g "$DOCKER_SOCKET")"
  fi
  # A fresh named volume is root-owned unless the image pre-created the mount
  # point; this only fixes the top directory, never the contents.
  chown "$SPRINT_USER:$SPRINT_USER" "$WORK_DIR"
  exec setpriv --reuid="$SPRINT_USER" --regid="$SPRINT_USER" "$groups_arg" \
    --no-new-privs --inh-caps=-all --bounding-set=-all "$0" "$@"
fi

# --- Stage 2 (non-root) ---

LOG_FILE=""

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) entrypoint: $*"
  echo "$line" >&2
  if [ -n "$LOG_FILE" ]; then
    echo "$line" >>"$LOG_FILE"
  fi
}

die() {
  log "ERROR: $*"
  exit "$EXIT_CONFIG"
}

require_var() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    die "required variable $name is not set or is empty"
  fi
}

refuse_var() {
  local name=$1 reason=$2
  if [ -n "${!name+set}" ]; then
    die "$name must not be set: $reason"
  fi
}

# Both of these outrank CLAUDE_CODE_OAUTH_TOKEN, so setting either would bill
# the API account instead of the subscription.
refuse_var ANTHROPIC_API_KEY "it would override CLAUDE_CODE_OAUTH_TOKEN and bill the API instead of the subscription"
refuse_var ANTHROPIC_AUTH_TOKEN "it would override CLAUDE_CODE_OAUTH_TOKEN and bill the API instead of the subscription"
require_var CLAUDE_CODE_OAUTH_TOKEN
require_var GH_TOKEN
require_var SPRINT_ID
require_var SPRINT_REPO_URL

# SPRINT_ID becomes part of paths, so keep it to a safe alphabet.
if ! [[ $SPRINT_ID =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  die "SPRINT_ID may contain only letters, digits, hyphen and underscore"
fi
# A URL with credentials would be written to /work/.git/config.
if [[ $SPRINT_REPO_URL =~ ://[^/]*@ ]]; then
  die "SPRINT_REPO_URL must not embed credentials; the token is supplied at use time"
fi

readonly STATE_DIR="$STATE_ROOT/$SPRINT_ID"
readonly PROMPT_FILE="$STATE_DIR/sprint-prompt.md"
readonly SESSION_LOG="$STATE_DIR/logs/sprint.jsonl"

if ! mkdir -p "$STATE_DIR/logs" 2>/dev/null; then
  die "cannot create $STATE_DIR/logs; check that .sprint/$SPRINT_ID is mounted and writable"
fi
LOG_FILE="$STATE_DIR/logs/entrypoint.log"

log "start: sprint=$SPRINT_ID uid=$(id -u) gid=$(id -g) groups=$(id -G | tr ' ' ',')"
log "tokens present: CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN (values never logged)"

if [ ! -f "$PROMPT_FILE" ]; then
  die "prompt file $PROMPT_FILE is missing"
fi

# --- Git over HTTPS with the token read from the environment ---

if [ -z "$(git config --global --get user.name || true)" ]; then
  git config --global user.name "sessiondeck sprint $SPRINT_ID"
  git config --global user.email "sprint-$SPRINT_ID@users.noreply.github.com"
fi
git config --global credential.https://github.com.helper "$CREDENTIAL_HELPER"

# --- Clone or fetch ---

if [ -d "$WORK_DIR/.git" ]; then
  log "fetch path: $WORK_DIR is already a clone"
  git -C "$WORK_DIR" remote set-url origin "$SPRINT_REPO_URL"
  git -C "$WORK_DIR" fetch --quiet --prune origin
  git -C "$WORK_DIR" remote set-head origin --auto >/dev/null || log "could not refresh origin/HEAD"
else
  log "clone path: cloning into $WORK_DIR"
  git clone --quiet "$SPRINT_REPO_URL" "$WORK_DIR"
fi

# --- Checkout ---

checkout_branch() {
  local branch=$1
  if git -C "$WORK_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$WORK_DIR" checkout --quiet "$branch"
    # A resumed volume may hold unpushed commits; never discard them.
    git -C "$WORK_DIR" merge --quiet --ff-only "origin/$branch" ||
      log "local $branch has diverged from origin/$branch; left as is"
  else
    git -C "$WORK_DIR" checkout --quiet -b "$branch" --track "origin/$branch"
  fi
}

default_branch="$(git -C "$WORK_DIR" symbolic-ref --short refs/remotes/origin/HEAD)"
default_branch="${default_branch#origin/}"
sprint_branch="${SPRINT_BRANCH:-}"
if [ -n "$sprint_branch" ] &&
  git -C "$WORK_DIR" show-ref --verify --quiet "refs/remotes/origin/$sprint_branch"; then
  log "checkout: sprint branch $sprint_branch exists on the remote"
  checkout_branch "$sprint_branch"
else
  log "checkout: sprint branch '${sprint_branch}' not on the remote, using default branch $default_branch"
  checkout_branch "$default_branch"
fi

# --- Run the level-1 prompt headless (infra/sprint/README.md) ---
# pipefail makes the pipeline's status claude's, not tee's.

cd "$WORK_DIR"
log "launching claude headless; stream goes to $SESSION_LOG"
rc=0
claude -p "$(cat "$PROMPT_FILE")" --agent "$SPRINT_AGENT" \
  --dangerously-skip-permissions --output-format stream-json --verbose |
  tee "$SESSION_LOG" || rc=$?
log "claude exited with status $rc"
exit "$rc"
