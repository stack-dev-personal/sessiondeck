#!/usr/bin/env bash
# One command for the live e2e (R3.1, R3.9): builds the hub image, starts hub + ws-gate + Playwright
# containers on a private network, runs e2e/R3.1 and R3.9, copies screenshots, removes everything.
#
#   packages/web/scripts/e2e-live.sh
#
# Env (all optional):
#   SD_E2E_PREFIX       container/network name prefix            (default sd-1-S6)
#   SD_E2E_SCREENS_OUT  where screenshots are copied             (default /state/1/screens/S6 if /state/1 exists, else packages/web/e2e/screens)
#   SD_E2E_WORK_VOLUME  docker volume that holds the checkout at its path (sprint container: sprint-1-work mounted at /work).
#                       Unset: the checkout is bind-mounted, which needs a host-visible path (CI, local).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
P="${SD_E2E_PREFIX:-sd-1-S6}"
NET="$P-net"; HUB="$P-hub"; GATE="$P-gate"; PW="$P-pw"
IMG="$(echo "$P" | tr 'A-Z' 'a-z')-hub:e2e"
PW_IMG="mcr.microsoft.com/playwright:v1.63.0-noble"
OUT="${SD_E2E_SCREENS_OUT:-}"
if [ -z "$OUT" ]; then
  if [ -d /state/1 ]; then OUT=/state/1/screens/S6; else OUT="$ROOT/packages/web/e2e/screens"; fi
fi
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() {
  docker rm -f "$PW" "$GATE" "$HUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker build -q -f "$ROOT/packages/hub/Dockerfile" -t "$IMG" "$ROOT" >/dev/null
docker network create "$NET" >/dev/null

docker run -d --name "$HUB" --network "$NET" \
  -e HUB_TOKEN="$TOKEN" -e HUB_BIND=0.0.0.0 -e HUB_ALLOWED_ORIGINS=http://localhost:5174 \
  "$IMG" >/dev/null
for _ in $(seq 1 40); do
  if docker exec "$HUB" node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done
[ "${ready:-0}" = 1 ] || { echo "hub did not become healthy" >&2; docker logs "$HUB" >&2; exit 1; }

docker create --name "$GATE" --network "$NET" -e UPSTREAM="$HUB:8787" \
  node:22-bookworm-slim node /gate.mjs >/dev/null
docker cp "$ROOT/packages/web/scripts/ws-gate.mjs" "$GATE:/gate.mjs"
docker start "$GATE" >/dev/null

if [ -n "${SD_E2E_WORK_VOLUME:-}" ]; then MOUNT=(-v "$SD_E2E_WORK_VOLUME:/work"); else MOUNT=(-v "$ROOT:$ROOT"); fi

set +e
docker run --name "$PW" --network "$NET" --ipc=host "${MOUNT[@]}" -w "$ROOT/packages/web" \
  -e HOME=/root -e CI=1 -e SCREENS_DIR=/tmp/screens \
  -e SD_E2E_HUB_URL="http://$GATE:8787" -e SD_E2E_HUB_DIRECT_URL="http://$HUB:8787" \
  -e SD_E2E_GATE_URL="http://$GATE:9000" -e SD_E2E_HUB_TOKEN="$TOKEN" \
  "$PW_IMG" sh -c 'node node_modules/@playwright/test/cli.js test; rc=$?; chown -R '"$(id -u):$(id -g)"' dist e2e /tmp/screens 2>/dev/null; exit $rc'
rc=$?
set -e

mkdir -p "$OUT"
docker cp "$PW:/tmp/screens/." "$OUT/" 2>/dev/null || echo "no screenshots to copy" >&2
echo "screenshots: $OUT"
exit "$rc"
