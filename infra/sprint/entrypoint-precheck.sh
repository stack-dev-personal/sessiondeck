#!/bin/sh
# Sprint container pre-stage: refuse a bad environment, then exec the bash
# entrypoint. Specification: infra/sprint/README.md.
#
# Why a separate POSIX sh script: bash sources $BASH_ENV and imports exported
# BASH_FUNC_* functions before the first line of any bash script runs, so an
# allow-list written in bash cannot stop them (an exported "exit" function turns
# a refusal into a no-op). Debian's /bin/sh is dash, which imports no functions
# and sources no startup file in a non-interactive script, so the names are
# checked here, before bash sees them. The dynamic loader still applies
# LD_PRELOAD to this process, which is why the compose file pins it to empty;
# an empty value is the only one accepted.
#
# What the list is for: it guards against configuration mistakes and accidental
# overrides (a proxy variable, a Bedrock switch, a stray ANTHROPIC_* name in
# .sprint/env). It is not a defense against someone who can write .sprint/env:
# that person already holds both tokens. Put nothing there except the two tokens.
#
# Secret hygiene: only variable NAMES are ever printed, never values, and a name
# with unusual characters is replaced by a fixed phrase so it cannot carry
# terminal escape sequences.
set -eu

EXIT_CONFIG=64
BASH_ENTRYPOINT=/usr/local/bin/sprint-entrypoint
# This shell's pid, not /proc/self: tr would open its own environ after the
# fork and read nothing once it execs, but this shell's file stays readable.
ENVIRON_FILE=/proc/$$/environ

# BEGIN env-checks
# Values the Dockerfile sets (ENV) and the node base image's PATH. The compose
# file pins the same values, and a different value is refused here as defense in
# depth for anyone running the image without the compose file.
# scripts/test/sprint-image-static.test.ts checks these against the Dockerfile.
PINNED_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PINNED_DISABLE_AUTOUPDATER=1
PINNED_CLAUDE_CONFIG_DIR=/home/sprint/.claude
PINNED_HOME=/home/sprint
PINNED_GIT_TERMINAL_PROMPT=0
PINNED_GH_PROMPT_DISABLED=1

refused=0

# Prints a name only when it is made of safe characters.
printable_name() {
  case $1 in
    '' | *[!A-Za-z0-9_%.-]*) printf '%s' '<name with unusual characters>' ;;
    *) printf '%s' "$1" ;;
  esac
}

refuse() {
  printf 'entrypoint: ERROR: environment variable %s %s\n' "$(printable_name "$1")" "$2" >&2
  refused=1
}

# check_pinned <name> <value> <expected>
check_pinned() {
  if [ "$2" != "$3" ]; then
    refuse "$1" "must keep the image value; remove it from .sprint/env"
  fi
}

# check_entry <NAME=value line>
check_entry() {
  entry=$1
  name=${entry%%=*}
  value=
  case $entry in *=*) value=${entry#*=} ;; esac

  case $name in
    SPRINT_*) ;;
    CLAUDE_CODE_OAUTH_TOKEN | GH_TOKEN) ;;
    DEBIAN_FRONTEND | HOSTNAME | TERM | PWD | OLDPWD | SHLVL | _ | NODE_VERSION | YARN_VERSION) ;;
    # Loader and shell startup hooks: accepted only when empty, because compose
    # pins them to empty and an empty value does nothing.
    BASH_ENV | LD_PRELOAD)
      if [ -n "$value" ]; then
        refuse "$name" "must be empty; remove it from .sprint/env"
      fi
      ;;
    BASH_FUNC_* | LD_*)
      refuse "$name" "is not allowed; remove it from .sprint/env or the Docker proxy settings"
      ;;
    DISABLE_AUTOUPDATER) check_pinned "$name" "$value" "$PINNED_DISABLE_AUTOUPDATER" ;;
    CLAUDE_CONFIG_DIR) check_pinned "$name" "$value" "$PINNED_CLAUDE_CONFIG_DIR" ;;
    HOME) check_pinned "$name" "$value" "$PINNED_HOME" ;;
    GIT_TERMINAL_PROMPT) check_pinned "$name" "$value" "$PINNED_GIT_TERMINAL_PROMPT" ;;
    GH_PROMPT_DISABLED) check_pinned "$name" "$value" "$PINNED_GH_PROMPT_DISABLED" ;;
    PATH) check_pinned "$name" "$value" "$PINNED_PATH" ;;
    *)
      refuse "$name" "is not on the allow-list; remove it from .sprint/env or the Docker proxy settings"
      ;;
  esac
}
# END env-checks

# The first external command below (tr) must not be found through a PATH that
# .sprint/env chose; the check of the original value happens on the environ copy.
PATH=$PINNED_PATH
export PATH

# Reading into a variable first makes a failing tr or an unreadable file stop
# the script (set -e) instead of looking like an empty, clean environment. A
# value that contains a newline adds a line that is checked as a name too, which
# can only refuse more, never less.
environment_lines=$(tr '\0' '\n' <"$ENVIRON_FILE")
if [ -z "$environment_lines" ]; then
  printf 'entrypoint: ERROR: could not read the process environment\n' >&2
  exit "$EXIT_CONFIG"
fi

while IFS= read -r line; do
  check_entry "$line"
done <<EOF
$environment_lines
EOF

if [ "$refused" -ne 0 ]; then
  exit "$EXIT_CONFIG"
fi

exec "$BASH_ENTRYPOINT" "$@"
