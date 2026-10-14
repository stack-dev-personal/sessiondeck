#!/usr/bin/env bash
# Container harness for the sprint image (requirement R0.8, "on Docker Desktop
# for Windows" and "tokens enter only through .sprint/env").
#
# Usage: infra/sprint/test/check-sprint-image.sh <output-dir> [--i-have-the-go]
#
# It builds the image, runs checks 1 to 9, prints one PASS, FAIL or SKIP line
# per check with the observed value, writes a copy of the output to
# <output-dir>/u2-container-check.txt, removes everything it created (the built
# image is kept on purpose), and exits non-zero if any check failed.
#
# It never reads or creates a real token: the env file is a placeholder file in
# a temp directory, and `.sprint/env` is never touched.
#
# Gate: it refuses to run (exit 2) unless the user's go file exists or
# --i-have-the-go is passed, so it cannot be started by accident.

set -uo pipefail

# Git Bash would rewrite /var/run/docker.sock and /state style arguments into
# Windows paths before docker sees them.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

readonly EXIT_REFUSED=2
readonly GO_FILE="C:/Users/stack/projects/sessiondeck/.sprint/0/answers/S0c-u2-go.md"
readonly GO_FLAG="--i-have-the-go"
readonly OUTPUT_NAME="u2-container-check.txt"

readonly IMAGE="${SPRINT_IMAGE:-sessiondeck-sprint:local}"
readonly PREFIX="sd-0-S0c"
readonly RUN_CONTAINER="$PREFIX-run"
readonly WORK_VOLUME="$PREFIX-work"
readonly SIBLING="$PREFIX-sibling"
# SPRINT_ID "smoke" makes the bind mount /state/smoke, which is exactly where
# the stub writes status.json (the documented smoke test).
readonly TEST_SPRINT_ID=smoke
readonly TEST_BRANCH=sprint/u2test
readonly REAL_BINARY_TIMEOUT_S=60
readonly OUTPUT_HEAD_LINES=5
readonly OUTPUT_LINE_MAX=300
readonly OAUTH_PLACEHOLDER="placeholder-oauth-not-a-token"
readonly GH_PLACEHOLDER="placeholder-gh-not-a-token"
readonly API_PLACEHOLDER="placeholder-api-not-a-key"
readonly SHELLCHECK_IMAGE="koalaman/shellcheck:stable"

# --- Arguments and gate ---

out_dir=""
have_go_flag=0
for arg in "$@"; do
  case "$arg" in
    "$GO_FLAG") have_go_flag=1 ;;
    *) [ -z "$out_dir" ] && out_dir="$arg" ;;
  esac
done

if [ "$have_go_flag" -ne 1 ] && [ ! -f "$GO_FILE" ]; then
  echo "refused: the user has not allowed the image build and harness run." >&2
  echo "Expected $GO_FILE, or pass $GO_FLAG." >&2
  exit "$EXIT_REFUSED"
fi
if [ -z "$out_dir" ]; then
  echo "usage: $0 <output-dir> [$GO_FLAG]" >&2
  exit "$EXIT_REFUSED"
fi

# --- Paths ---

to_native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sprint_dir="$(cd "$here/.." && pwd)"
repo_root="$(cd "$sprint_dir/../.." && pwd)"
mkdir -p "$out_dir"
out_file="$out_dir/$OUTPUT_NAME"
: >"$out_file"
exec > >(tee "$out_file") 2>&1

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/$PREFIX.XXXXXX")"
tmp_native="$(to_native "$tmp_dir")"
state_root="$tmp_dir/state"
state_dir="$state_root/$TEST_SPRINT_ID"
mkdir -p "$state_dir/logs"
env_file="$tmp_dir/test.env"
remote_dir="$tmp_dir/remote.git"
prompt_file="$state_dir/sprint-prompt.md"

# --- Result bookkeeping ---

failures=0
pass() { echo "PASS  $1: $2"; }
fail() { echo "FAIL  $1: $2"; failures=$((failures + 1)); }
skip() { echo "SKIP  $1: $2"; }

# expect_eq name expected observed
expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1" "$3"; else fail "$1" "expected '$2', observed '$3'"; fi
}

# expect_zero name count: a secret-hygiene count that must be 0.
expect_zero() {
  if [ "$2" = "0" ]; then pass "$1" "0 matches"; else fail "$1" "$2 matches"; fi
}

# --- Cleanup ---

cleanup() {
  echo "cleanup: removing containers, volume and temp directory created here"
  compose down --remove-orphans >/dev/null 2>&1
  docker rm -f "$RUN_CONTAINER" "$SIBLING" >/dev/null 2>&1
  docker volume rm "$WORK_VOLUME" >/dev/null 2>&1
  # Remove exactly the directory this run made, and only if it is what mktemp
  # returned (never a recursive delete on an unchecked path).
  case "$tmp_dir" in
    */"$PREFIX".??????) rm -rf "$tmp_dir" ;;
    *) echo "cleanup: refusing to delete unexpected path $tmp_dir" ;;
  esac
  echo "result: $failures failure(s); output copy at $out_file"
}
trap cleanup EXIT

# --- Compose wrapper (production file plus the test override) ---

compose() {
  SPRINT_ID="$TEST_SPRINT_ID" \
    SPRINT_BRANCH="$TEST_BRANCH" \
    SPRINT_REPO_URL=/remote/repo.git \
    SPRINT_IMAGE="$IMAGE" \
    SPRINT_ENV_FILE="$tmp_native/test.env" \
    SPRINT_STATE_ROOT="$tmp_native/state" \
    HARNESS_CONTAINER="$RUN_CONTAINER" \
    HARNESS_WORK_VOLUME="$WORK_VOLUME" \
    HARNESS_STUB="$(to_native "$here/claude-stub.sh")" \
    HARNESS_REMOTE="$tmp_native/remote.git" \
    docker compose -f "$sprint_dir/docker-compose.yml" -f "$here/docker-compose.test.yml" "$@"
}

# --- Fixtures ---

make_fixtures() {
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\nGH_TOKEN=%s\n' "$OAUTH_PLACEHOLDER" "$GH_PLACEHOLDER" >"$env_file"
  chmod 600 "$env_file"
  # Multi-line prompt with quotes, so argv fidelity is a real test.
  # shellcheck disable=SC2016 # the literal $dollar must reach the prompt unexpanded
  printf 'Write /state/smoke/status.json with state green and exit.\nSecond line with "quotes" and $dollar.\n' >"$prompt_file"
  git clone --quiet --bare "$repo_root" "$remote_dir"
  git -C "$remote_dir" branch "$TEST_BRANCH" HEAD
  chmod +x "$here/claude-stub.sh"
}

# read_fact <facts-file> <key>
read_fact() { sed -n "s/^$2=//p" "$1" | head -n 1; }

# --- Checks ---

build_image() {
  local start=$SECONDS
  if docker build -t "$IMAGE" "$sprint_dir"; then
    local size
    size="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
    pass "build" "tag=$IMAGE size_bytes=$size build_seconds=$((SECONDS - start))"
  else
    fail "build" "docker build failed after $((SECONDS - start))s"
    exit 1
  fi
}

check_1_contents() {
  local pnpm_pin claude_pin out
  pnpm_pin="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$repo_root/package.json")"
  claude_pin="$(sed -n 's/^ARG CLAUDE_CODE_VERSION=//p' "$sprint_dir/Dockerfile")"
  out="$(docker run --rm --name "$PREFIX-contents" --user sprint --entrypoint bash "$IMAGE" -c '
    echo "node=$(node -p "process.versions.node.split(\".\")[0]")"
    echo "pnpm=$(pnpm --version)"
    echo "git=$(git --version)"
    echo "gh=$(gh --version | head -n 1)"
    echo "docker=$(docker --version)"
    echo "compose=$(docker compose version)"
    echo "claude=$(claude --version)"
  ' 2>&1)"
  expect_eq "1 node major" "22" "$(read_fact <(echo "$out") node)"
  expect_eq "1 pnpm equals pin" "$pnpm_pin" "$(read_fact <(echo "$out") pnpm)"
  for key in git gh docker compose; do
    local value
    value="$(read_fact <(echo "$out") "$key")"
    if [ -n "$value" ]; then pass "1 $key present" "$value"; else fail "1 $key present" "missing"; fi
  done
  case "$(read_fact <(echo "$out") claude)" in
    "$claude_pin"*) pass "1 claude equals pin" "$claude_pin" ;;
    *) fail "1 claude equals pin" "expected $claude_pin, observed '$(read_fact <(echo "$out") claude)'" ;;
  esac
}

# Runs the stub container to completion; sets run_rc and run_seconds.
run_stub_container() {
  local start=$SECONDS
  rm -f "$state_dir/status.json"
  compose up -d --no-build >/dev/null
  run_rc="$(docker wait "$RUN_CONTAINER")"
  run_seconds=$((SECONDS - start))
  docker logs "$RUN_CONTAINER" >"$tmp_dir/container.log" 2>&1
  docker cp "$RUN_CONTAINER:/home/sprint/.gitconfig" "$tmp_dir/gitconfig" >/dev/null 2>&1 || : >"$tmp_dir/gitconfig"
  compose down --remove-orphans >/dev/null 2>&1
}

# verify_run <label>: checks 2, 3 and 4 against the logs the stub left.
verify_run() {
  local label=$1 facts="$state_dir/logs/stub-facts.txt" argv_file="$state_dir/logs/claude-argv.bin"
  expect_eq "$label exit code" "0" "$run_rc"
  echo "INFO  $label elapsed: ${run_seconds}s"

  local uid
  uid="$(read_fact "$facts" uid)"
  if [ -n "$uid" ] && [ "$uid" != "0" ]; then pass "$label 2 stub uid is not root" "uid=$uid"; else fail "$label 2 stub uid is not root" "uid='$uid'"; fi
  expect_eq "$label 2 /work writable" "yes" "$(read_fact "$facts" work_writable)"
  expect_eq "$label 2 /state/<id> writable" "yes" "$(read_fact "$facts" state_writable)"

  local server
  server="$(read_fact "$facts" docker_server)"
  case "$server" in
    [0-9]*) pass "$label 3 docker version reaches host daemon" "server=$server" ;;
    *) fail "$label 3 docker version reaches host daemon" "observed '$server'" ;;
  esac
  expect_eq "$label 3 sibling container ran" "0" "$(read_fact "$facts" sibling_rc)"
  expect_eq "$label 3 sibling removed (inside)" "0" "$(read_fact "$facts" sibling_left)"
  expect_eq "$label 3 sibling removed (host)" "" "$(docker ps -aq --filter "name=$SIBLING")"

  local -a argv=()
  if [ -f "$argv_file" ]; then mapfile -d '' -t argv <"$argv_file"; fi
  local expected_prompt
  expected_prompt="$(cat "$prompt_file")"
  expect_eq "$label 4 argv count" "8" "${#argv[@]}"
  expect_eq "$label 4 argv -p" "-p" "${argv[0]:-}"
  expect_eq "$label 4 argv prompt equals prompt file" "$expected_prompt" "${argv[1]:-}"
  expect_eq "$label 4 argv --agent" "--agent" "${argv[2]:-}"
  expect_eq "$label 4 argv agent name" "sd-sprint-orchestrator" "${argv[3]:-}"
  expect_eq "$label 4 argv skip-permissions" "--dangerously-skip-permissions" "${argv[4]:-}"
  expect_eq "$label 4 argv --output-format" "--output-format" "${argv[5]:-}"
  expect_eq "$label 4 argv format value" "stream-json" "${argv[6]:-}"
  expect_eq "$label 4 argv --verbose" "--verbose" "${argv[7]:-}"

  if grep -q '"green"' "$state_root/smoke/status.json" 2>/dev/null; then
    pass "$label 4 status.json visible on host with state green" "$state_root/smoke/status.json"
  else
    fail "$label 4 status.json visible on host with state green" "missing or wrong"
  fi
  if [ -s "$state_dir/logs/sprint.jsonl" ]; then pass "$label 4 sprint.jsonl exists" "$(wc -c <"$state_dir/logs/sprint.jsonl") bytes"; else fail "$label 4 sprint.jsonl exists" "missing or empty"; fi
  expect_eq "$label 4 checked-out branch" "$TEST_BRANCH" "$(read_fact "$facts" git_branch)"
  expect_eq "$label 4 origin URL has no credentials" "/remote/repo.git" "$(read_fact "$facts" git_origin)"
  expect_eq "$label 4 credential helper returns GH_TOKEN" "yes" "$(read_fact "$facts" credential_helper_matches_env)"
}

check_5_real_binary() {
  local who rc out
  for who in root sprint; do
    out="$(docker run --rm --name "$PREFIX-real-$who" --user "$who" --entrypoint timeout "$IMAGE" \
      "$REAL_BINARY_TIMEOUT_S" claude -p "hi" --dangerously-skip-permissions \
      --output-format stream-json --verbose </dev/null 2>&1)"
    rc=$?
    echo "INFO  5 real binary as $who: exit code $rc"
    echo "$out" | head -n "$OUTPUT_HEAD_LINES" | cut -c "1-$OUTPUT_LINE_MAX" | sed "s/^/INFO  5 $who output: /"
    if [ "$who" = root ]; then
      if [ "$rc" -ne 0 ] && echo "$out" | grep -q "cannot be used with root/sudo"; then
        pass "5 root is refused with the documented message" "exit $rc"
      else
        fail "5 root is refused with the documented message" "exit $rc"
      fi
    else
      if [ "$rc" -ne 124 ] && [ "$rc" -ne 0 ]; then
        pass "5 non-root does not hang and ends with an error (expected: authentication failure)" "exit $rc"
      else
        fail "5 non-root does not hang and ends with an error" "exit $rc (124 means it hung); report the output above verbatim"
      fi
    fi
  done
}

count_matches() { grep -rlF -e "$OAUTH_PLACEHOLDER" -e "$GH_PLACEHOLDER" "$@" 2>/dev/null | wc -l | tr -d ' '; }

check_6_hygiene() {
  expect_zero "6 docker logs" "$(count_matches "$tmp_dir/container.log")"
  expect_zero "6 /state/<id>/logs/*" "$(count_matches "$state_dir/logs")"
  expect_zero "6 ~/.gitconfig of the run" "$(count_matches "$tmp_dir/gitconfig")"
  docker run --rm --name "$PREFIX-gitconfig" -v "$WORK_VOLUME:/work:ro" --entrypoint cat "$IMAGE" /work/.git/config >"$tmp_dir/work-git-config" 2>&1
  expect_zero "6 /work/.git/config" "$(count_matches "$tmp_dir/work-git-config")"
  docker history --no-trunc "$IMAGE" >"$tmp_dir/history.txt" 2>&1
  expect_zero "6 docker history --no-trunc" "$(count_matches "$tmp_dir/history.txt")"
}

# run_guard <name> <env-lines...>: the entrypoint must fail naming the variable.
run_guard() {
  local name=$1 expect_var=$2
  shift 2
  printf '%s\n' "$@" >"$tmp_dir/guard.env"
  local out rc
  out="$(docker run --rm --name "$PREFIX-guard" --env-file "$tmp_native/guard.env" \
    -e SPRINT_ID=guard -e SPRINT_REPO_URL=/nowhere "$IMAGE" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "$expect_var"; then
    pass "7 guard: $name" "exit $rc, message names $expect_var"
  else
    fail "7 guard: $name" "exit $rc, output: $(echo "$out" | head -n 2)"
  fi
  if echo "$out" | grep -qF -e "$OAUTH_PLACEHOLDER" -e "$GH_PLACEHOLDER" -e "$API_PLACEHOLDER"; then
    fail "7 guard: $name message has no value" "a placeholder value was printed"
  else
    pass "7 guard: $name message has no value" "no placeholder in output"
  fi
}

check_7_guards() {
  run_guard "CLAUDE_CODE_OAUTH_TOKEN missing" CLAUDE_CODE_OAUTH_TOKEN "GH_TOKEN=$GH_PLACEHOLDER"
  run_guard "GH_TOKEN missing" GH_TOKEN "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_PLACEHOLDER"
  run_guard "ANTHROPIC_API_KEY set" ANTHROPIC_API_KEY \
    "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_PLACEHOLDER" "GH_TOKEN=$GH_PLACEHOLDER" "ANTHROPIC_API_KEY=$API_PLACEHOLDER"
  run_guard "ANTHROPIC_AUTH_TOKEN set" ANTHROPIC_AUTH_TOKEN \
    "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_PLACEHOLDER" "GH_TOKEN=$GH_PLACEHOLDER" "ANTHROPIC_AUTH_TOKEN=$API_PLACEHOLDER"
}

check_8_second_run() {
  run_stub_container
  local log="$state_dir/logs/entrypoint.log"
  local clones fetches
  clones="$(grep -c 'clone path' "$log")"
  fetches="$(grep -c 'fetch path' "$log")"
  expect_eq "8 clone path taken once in total" "1" "$clones"
  expect_eq "8 fetch path taken on the second run" "1" "$fetches"
  verify_run "second-run"
}

check_9_shellcheck() {
  if ! docker image inspect "$SHELLCHECK_IMAGE" >/dev/null 2>&1 && ! docker pull --quiet "$SHELLCHECK_IMAGE" >/dev/null 2>&1; then
    skip "9 shellcheck" "$SHELLCHECK_IMAGE could not be pulled"
    return
  fi
  local out rc
  out="$(docker run --rm --name "$PREFIX-shellcheck" -v "$(to_native "$sprint_dir"):/mnt:ro" "$SHELLCHECK_IMAGE" \
    -s bash -x /mnt/entrypoint.sh /mnt/test/claude-stub.sh /mnt/test/check-sprint-image.sh 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then pass "9 shellcheck" "clean"; else fail "9 shellcheck" "exit $rc: $(echo "$out" | head -n 10)"; fi
}

# --- Main ---

echo "harness start: image=$IMAGE temp=$tmp_dir"
make_fixtures
build_image
check_1_contents
run_stub_container
verify_run "first-run"
check_6_hygiene
check_5_real_binary
check_7_guards
check_8_second_run
check_9_shellcheck

[ "$failures" -eq 0 ]
