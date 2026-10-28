#!/usr/bin/env bash
# One command for the live e2e: builds the hub image, starts hub + ws-gate + Playwright containers
# on a private network, runs every live spec (R3.1, R3.3, R3.6, R3.9, R5.5-live, R5.4-live with real hub CORS and a hub restart through the host-side poller; SD_E2E_SKIP_PERF=1 skips the 40 s perf run), copies
# screenshots, removes everything.
#
#   packages/web/scripts/e2e-live.sh
#
# Env (all optional):
#   SD_E2E_PREFIX       container/network name prefix            (default sd-1-S6)
#   SD_E2E_SCREENS_OUT  where screenshots are copied             (default /state/1/screens/S6 if /state/1 exists, else packages/web/e2e/screens)
#   SD_E2E_RESULTS_OUT  where Playwright's results dir (actual/expected/diff, traces) is copied, also on failure (default: not copied)
#   SD_E2E_ARGS         extra Playwright CLI args, e.g. R3.6 to run one spec  (default: none)
#   SD_E2E_SKIP_PERF    1 skips R3.6 (the 40 s load and trace run) for quick runs
#   SD_E2E_WORK_VOLUME  docker volume that holds the checkout at its path (sprint container: sprint-1-work mounted at /work).
#                       Unset: the checkout is bind-mounted, which needs a host-visible path (CI, local).
#
# Hardening: the Playwright container is root on a rw mount of the checkout, so (1) the whole script is one function
# called on the last line, so bash has parsed every byte before `docker run` and in-place edits of this file are not
# executed; (2) the restart channel is not a shared file or mount: the host only runs `docker exec <pw> test -e` (exit
# code only) and `touch`, never reads or writes container-controlled host paths. Residual risk: the checkout is still
# mounted rw (work-volume mode cannot mount sub-paths read-only), so a container can plant files (.git/hooks,
# node_modules/.bin) that later host-side tooling in the same checkout might run; review the tree after a run.
set -euo pipefail

main() {
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
P="${SD_E2E_PREFIX:-sd-1-S6}"
NET="$P-net"; HUB="$P-hub"; GATE="$P-gate"; PW="$P-pw"
IMG="$(echo "$P" | tr 'A-Z' 'a-z')-hub:e2e"
# Pinned by tag and by the digest that was present locally when this was written.
PW_IMG="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
NODE_IMG="node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
RESULTS_OUT="${SD_E2E_RESULTS_OUT:-}"
OUT="${SD_E2E_SCREENS_OUT:-}"
if [ -z "$OUT" ]; then
  if [ -d /state/1 ]; then OUT=/state/1/screens/S6; else OUT="$ROOT/packages/web/e2e/screens"; fi
fi
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

ENVDIR=""
POLLER=""
cleanup() {
  docker rm -f "$PW" "$GATE" "$HUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMG" >/dev/null 2>&1 || true
  [ -z "$POLLER" ] || kill "$POLLER" >/dev/null 2>&1 || true
  [ -z "$ENVDIR" ] || rm -rf "$ENVDIR"
}
trap cleanup EXIT
cleanup

# The token goes in through 0600 env files, not -e, so it is not in `ps` or `docker inspect` args.
ENVDIR="$(mktemp -d)"
chmod 700 "$ENVDIR"
( umask 077
  printf 'HUB_TOKEN=%s\nHUB_BIND=0.0.0.0\nHUB_ALLOWED_ORIGINS=http://localhost:5174\n' "$TOKEN" > "$ENVDIR/hub.env"
  printf 'SD_E2E_HUB_TOKEN=%s\n' "$TOKEN" > "$ENVDIR/pw.env" )

docker build -q -f "$ROOT/packages/hub/Dockerfile" -t "$IMG" "$ROOT" >/dev/null
# --internal: no egress from the test network (images are built/pulled above; nothing in the run needs it).
docker network create --internal "$NET" >/dev/null

docker run -d --name "$HUB" --network "$NET" \
  --env-file "$ENVDIR/hub.env" \
  "$IMG" >/dev/null
for _ in $(seq 1 40); do
  if docker exec "$HUB" node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done
[ "${ready:-0}" = 1 ] || { echo "hub did not become healthy" >&2; docker logs "$HUB" >&2; exit 1; }

docker create --name "$GATE" --network "$NET" -e UPSTREAM="$HUB:8787" \
  "$NODE_IMG" node /gate.mjs >/dev/null
docker cp "$ROOT/packages/web/scripts/ws-gate.mjs" "$GATE:/gate.mjs"
docker start "$GATE" >/dev/null

# Mount: no Docker socket anywhere. The checkout (node_modules, build output, specs) is read-write because Playwright writes dist/
# and e2e/__screenshots__. With a work volume the whole volume is mounted (the sprint container keeps
# every checkout there); that is the documented exception. --shm-size replaces --ipc=host (Chromium
# needs more than Docker's default 64 MB of shared memory, not the host IPC namespace).
if [ -n "${SD_E2E_WORK_VOLUME:-}" ]; then MOUNT=(-v "$SD_E2E_WORK_VOLUME:/work"); else MOUNT=(-v "$ROOT:$ROOT"); fi

docker create --name "$PW" --network "$NET" --shm-size=1g "${MOUNT[@]}" -w "$ROOT/packages/web" \
  -e HOME=/root -e CI=1 -e SCREENS_DIR=/tmp/screens \
  -e SD_E2E_HUB_URL="http://$GATE:8787" -e SD_E2E_HUB_DIRECT_URL="http://$HUB:8787" \
  -e SD_E2E_RESTART_DIR=/tmp/sd-req \
  -e SD_E2E_GATE_URL="http://$GATE:9000" -e SD_E2E_SKIP_PERF="${SD_E2E_SKIP_PERF:-}" -e SD_E2E_ARGS="${SD_E2E_ARGS:-}" --env-file "$ENVDIR/pw.env" \
  "$PW_IMG" sh -c 'mkdir -p /tmp/sd-req; node node_modules/@playwright/test/cli.js test $SD_E2E_ARGS; rc=$?; chown -R '"$(id -u):$(id -g)"' dist e2e /tmp/screens /tmp/sd-pw-results 2>/dev/null; exit $rc'
docker start "$PW" >/dev/null
# Hub restart for R5.5-live without the Docker socket and without any host path shared with the container.
# The spec creates /tmp/sd-req/restart.req inside its own container; this host-side poller asks the container
# only for an exit code, never reads the request, restarts exactly "$HUB", then creates a constant
# /tmp/sd-req/restart.ack inside the container. Bounded to 25 min, killed on EXIT.
(
  end=$((SECONDS + 1500))
  while [ "$SECONDS" -lt "$end" ]; do
    if docker exec "$PW" sh -c 'test -f /tmp/sd-req/restart.req && ! test -L /tmp/sd-req/restart.req' >/dev/null 2>&1; then
      docker exec "$PW" rm -f /tmp/sd-req/restart.req >/dev/null 2>&1 || true
      docker restart -t 2 "$HUB" >/dev/null 2>&1 || true
      docker exec "$PW" sh -c ': > /tmp/sd-req/restart.ack' >/dev/null 2>&1 || true
    fi
    sleep 0.3
  done
) &
POLLER=$!
set +e
docker logs -f "$PW"
rc=$(docker wait "$PW")
set -e

mkdir -p "$OUT"
docker cp "$PW:/tmp/screens/." "$OUT/" 2>/dev/null || echo "no screenshots to copy" >&2
echo "screenshots: $OUT"
if [ -n "$RESULTS_OUT" ]; then
  mkdir -p "$RESULTS_OUT"
  docker cp "$PW:/tmp/sd-pw-results/." "$RESULTS_OUT/" 2>/dev/null || echo "no results dir to copy" >&2
  echo "results: $RESULTS_OUT"
fi
exit "$rc"

}
main "$@"
exit $?
