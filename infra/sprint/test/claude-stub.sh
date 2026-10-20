#!/usr/bin/env bash
# Test double for the claude CLI. A compose override mounts this over the real
# binary; nothing in the production image or entrypoint knows about it.
#
# It records its argv (NUL separated, so a multi-line prompt survives) and a few
# facts about the process, performs the smoke action, and prints one
# stream-json result line. It never records its environment. The harness runs
# it with placeholder tokens only; to prove the entrypoint's output filter it
# deliberately prints both placeholder values, once to stdout and once to
# stderr, as a session running `env` would. Otherwise the only secret-related
# output is a yes/no from comparing the git credential helper's answer with
# GH_TOKEN.
set -euo pipefail

readonly LOG_DIR="/state/${SPRINT_ID}/logs"
readonly FACTS="$LOG_DIR/stub-facts.txt"
readonly SIBLING=sd-0-S0c-sibling
readonly SIBLING_IMAGE=node:22.23.3-bookworm-slim
readonly SMOKE_DIR=/state/smoke
readonly SLEEP_PROMPT="stub: sleep until stopped"
readonly SLEEP_SECONDS=300

printf '%s\0' "$@" >"$LOG_DIR/claude-argv.bin"

# Sleep mode, chosen by the prompt text (argv[1] after -p) because the harness
# controls the prompt file and the entrypoint's environment allow-list would
# refuse a new variable. It lets the harness prove that docker stop reaches the
# process: exec makes this process the sleeper, so SIGTERM ends it with status
# 143 and the entrypoint must log exactly that.
if [ "${2:-}" = "$SLEEP_PROMPT" ]; then
  : >"$LOG_DIR/stub-sleeping"
  exec sleep "$SLEEP_SECONDS"
fi

yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

{
  echo "uid=$(id -u)"
  echo "gid=$(id -g)"
  echo "cwd=$PWD"
  echo "work_writable=$(yes_no touch /work/.stub-write-test)"
  echo "state_writable=$(yes_no touch "/state/${SPRINT_ID}/.stub-write-test")"
  rm -f /work/.stub-write-test "/state/${SPRINT_ID}/.stub-write-test"
  echo "git_branch=$(git -C /work rev-parse --abbrev-ref HEAD)"
  echo "git_origin=$(git -C /work remote get-url origin)"
  echo "docker_server=$(docker version --format '{{.Server.Version}}' 2>&1 | head -n 1)"
  if docker run --rm --name "$SIBLING" "$SIBLING_IMAGE" true >/dev/null 2>&1; then
    echo "sibling_rc=0"
  else
    echo "sibling_rc=$?"
  fi
  echo "sibling_left=$(docker ps -aq --filter "name=$SIBLING" | wc -l | tr -d ' ')"
  # The helper must return GH_TOKEN; compare here and print only the verdict.
  answer="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')"
  if [ "$answer" = "$GH_TOKEN" ]; then
    echo "credential_helper_matches_env=yes"
  else
    echo "credential_helper_matches_env=no"
  fi
  # The nested-launch mirror must carry the same value as the canonical name.
  # Only the verdict is recorded, never either value.
  if [ -z "${SPRINT_CLAUDE_OAUTH_TOKEN:-}" ]; then
    echo "mirror-token=missing"
  elif [ "$SPRINT_CLAUDE_OAUTH_TOKEN" = "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    echo "mirror-token=equal"
  else
    echo "mirror-token=differs"
  fi
} >"$FACTS" 2>&1

mkdir -p "$SMOKE_DIR"
printf '{"state":"green"}\n' >"$SMOKE_DIR/status.json.tmp"
mv "$SMOKE_DIR/status.json.tmp" "$SMOKE_DIR/status.json"

printf '{"type":"assistant","text":"leak-probe %s %s"}\n' "$CLAUDE_CODE_OAUTH_TOKEN" "$GH_TOKEN"
printf 'leak-probe-stderr %s %s\n' "$CLAUDE_CODE_OAUTH_TOKEN" "$GH_TOKEN" >&2
echo '{"type":"result","subtype":"success","is_error":false,"result":"stub"}'
