#!/bin/sh
# Runs from /docker-entrypoint.d/ before 20-envsubst-on-templates.sh (scripts run in sorted order).
# SD_WEB_CONNECT_SRC is substituted raw into an nginx quoted string; allow only origin-like characters.
set -eu
case "${SD_WEB_CONNECT_SRC:-}" in
  ""|*[!A-Za-z0-9:/.*\ -]*)
    echo "05-validate-sd-env: SD_WEB_CONNECT_SRC is empty or has characters outside [A-Za-z0-9:/.* -]; refusing to start" >&2
    exit 1 ;;
esac
