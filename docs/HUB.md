# Hub

The hub is the stateless-apart-from-its-database service of sessiondeck. Probes on laptops POST event envelopes to it; it stores them, reduces them into per-session snapshots, and serves those snapshots over REST and a WebSocket to the web UI. It holds no state that a restart would lose: everything lives in the database (SQLite in the MVP, Postgres in Phase 7), and the process can be copied to another machine unchanged.

Source: `packages/hub`. Contract types and schemas: `packages/contract`.

## Run locally

```sh
pnpm install
HUB_TOKEN=$(openssl rand -base64 24) pnpm -F @sessiondeck/hub start
```

`start` bundles `src/main.ts` with esbuild (`scripts/bundle.mjs`, output `dist/main.mjs`) and runs it with Node 22. `pnpm -F @sessiondeck/hub bundle` only builds. The hub refuses to start without `HUB_TOKEN` (at least 16 characters). By default it listens on `127.0.0.1:8787` and keeps its database in `./data/hub.sqlite`.

## Run in Docker

The image is built from `packages/hub/Dockerfile`; the build context is the repository root. `packages/hub/Dockerfile.dockerignore` keeps the context small when BuildKit is used.

```sh
docker build -f packages/hub/Dockerfile -t sd-hub:dev .
docker volume create sd-hub-data
docker run -d --name sd-hub -p 127.0.0.1:8787:8787 \
  -v sd-hub-data:/data \
  -e HUB_TOKEN -e HUB_BIND=0.0.0.0 \
  sd-hub:dev
```

Export `HUB_TOKEN` in the shell first (`-e HUB_TOKEN` without a value passes it through without putting it on the command line). The value is still visible through `docker inspect` (and `/proc/<pid>/environ`) to anyone with access to the Docker socket, which is root-equivalent on the host. Phase 7 should move to a Docker secret or a `_FILE` variant (not implemented yet). Notes:

- Multi-stage build on `node:22-bookworm-slim` (a multi-arch tag that includes `linux/arm64`). Digest pinning is a deferred follow-up for the release process (pin the multi-arch index digest, `node:22-bookworm-slim@sha256:...`); it is also noted in the Dockerfile.
- pnpm comes from corepack at the version in the root `packageManager` field; dependencies install with `--frozen-lockfile`.
- `better-sqlite3` is compiled from source in the build stage (`npm_config_build_from_source=true`; python3, make and g++ exist in that stage only). No prebuilt binary is downloaded.
- The runtime stage holds the bundle and the production `node_modules` only (`better-sqlite3`, `fastify`, `ws`, and their dependencies). The contract package and zod are bundled, and the deployed contract package is removed from the runtime image.
- The Dockerfile copies explicit files only (never whole package directories) so the image is clean even with the legacy builder, which ignores `Dockerfile.dockerignore`: untracked `fixtures/raw`, `.env`, `probe.json` and a local `data/hub.sqlite` cannot reach it. `container:smoke` proves this with canary files.
- The process runs as uid 10001 (`hub`), not root. `/data` is a `VOLUME` owned by that user with mode 0700; `HUB_DB_PATH` defaults to `/data/hub.sqlite` in the image. The database file is created with mode 0600.
- `HUB_BIND` must be `0.0.0.0` inside a container, otherwise nothing outside can reach it. Publish the port on `127.0.0.1` only unless a reverse proxy or tunnel fronts it.
- `HEALTHCHECK` runs `node -e fetch(...)` against `http://127.0.0.1:8787/health` inside the container (loopback, not an outbound call).
- No secret is baked into the image. `HUB_TOKEN` is supplied at run time.
- `docker compose` wiring is owned by the S4 session (`infra/docker-compose.yml`).

Proof harness: `pnpm -F @sessiondeck/hub container:smoke` builds the image, runs it on a docker network with a volume, and prints evidence (health, 401s, fixture ingest, dedup, restart persistence, uid, file mode, WS harness). It only creates and removes objects named `sd-1-S3-*` (override with `SMOKE_PREFIX`, `SMOKE_NETWORK`, `SMOKE_IMAGE`). It stages a scratch build context (plus canary files) and builds with `DOCKER_BUILDKIT=0`, so it works where BuildKit is not installed and fails if a canary reaches the runtime image.

By default the harness reaches the hub by container name (`http://sd-1-S3-hub:8787`), which only resolves from a container attached to the sprint network (`SMOKE_NETWORK`, default `sprint-1_default`), for example inside the sprint container. To run it from the host instead, set `SMOKE_HOST_PORT=<port>`: the hub is then published on `127.0.0.1:<port>` and the harness uses localhost.

Unverified: the `SMOKE_HOST_PORT` path has never run successfully on a real host; treat it as untested until someone does. It works only when the harness and the Docker daemon share a network namespace (harness on the host itself); inside the sprint container use the default container-name mode, because `-p 127.0.0.1:<port>:8787` binds on the daemon host's loopback, not the harness container's.

The root `.dockerignore` is defense in depth, checked by hand: the smoke harness builds from a scratch staged context, so its canary check does not exercise that file. The tested control is the Dockerfile's explicit COPY list.

### arm64

Phase 7 runs linux/arm64. Nothing in the Dockerfile is amd64-only: the base tag is multi-arch, corepack and pnpm fetch the binary for the build platform, and `better-sqlite3` is compiled from source rather than fetched as a platform prebuilt. Building for arm64 on an amd64 host needs QEMU binfmt (or buildx with an arm64 builder); `container:smoke` reports whether that is available and builds `linux/arm64` when it is.

## Environment variables

| Variable                | Default                         | Meaning                                                                                                                                  |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_TOKEN`             | none, required                  | Bearer token for every route except `/health`. At least 16 characters.                                                                   |
| `HUB_PORT`              | `8787`                          | TCP port, 1 to 65535.                                                                                                                    |
| `HUB_BIND`              | `127.0.0.1`                     | Bind address (D-S3-4). A LAN or container bind (`0.0.0.0`) is an explicit opt-in.                                                        |
| `HUB_DB_PATH`           | `./data/hub.sqlite` (image: `/data/hub.sqlite`) | SQLite file. The directory is created with mode 0700 if missing.                                                         |
| `HUB_INGEST_RATE`       | `5000`                          | Global ingest limit, envelopes per second, keyed on the digest of the authenticated token (D-S3-5).                                      |
| `HUB_INGEST_BURST`      | `max(2 x rate, 5000)`           | Global ingest bucket size. Must be at least 5000, the largest batch.                                                                     |
| `HUB_HOST_RATE`         | `HUB_INGEST_RATE`               | Per-host fairness limit, envelopes per second, keyed on the validated `host`.                                                            |
| `HUB_HOST_BURST`        | `max(2 x host rate, 5000)`      | Per-host bucket size. At least 5000.                                                                                                     |
| `HUB_MAX_HOSTS`         | `32`                            | Hosts not yet in the `hosts` table are refused (429) once the table holds this many.                                                     |
| `HUB_MAX_OPEN_SESSIONS` | `1000`                          | New sessions for a host are not created once it has this many open (non-ended) sessions. Events are still stored.                        |
| `HUB_READ_RATE`         | `50`                            | Read limit, requests per second, for REST GETs and WS upgrades, keyed on the credential that authenticated (D-S3-14).                    |
| `HUB_READ_BURST`        | `100`                           | Read bucket size.                                                                                                                        |
| `HUB_MAX_WS_CLIENTS`    | `64`                            | Concurrent `/stream` clients. Further upgrades get 503.                                                                                  |
| `HUB_ALLOWED_ORIGINS`   | empty (compose: `http://localhost:5173,http://127.0.0.1:5173`) | Comma-separated Origin allow-list. Each entry must be `http(s)://host[:port]` with no path; `null` and `*` are rejected at startup. Gates WS upgrades (any other Origin is refused, 403) and turns on REST CORS for every route except `/ingest`. Empty disables CORS. See security. |
| `HUB_MAX_CLOCK_SKEW_MS` | `86400000` (1 day)              | An envelope whose `ts` is more than this ahead of the hub clock refuses the whole batch (400 `too_far_in_future`; a warn log with counts only). Range 60000 (1 min) to 604800000 (7 days); outside it the hub does not start. |
| `HUB_EVENT_RETENTION_DAYS` | `30` | Events older than this are folded into per-session baselines and deleted by compaction. |
| `HUB_SAMPLE_RETENTION_DAYS` | `30` | Statusline samples older than this are deleted. |
| `HUB_RETENTION_INTERVAL_MS` | `3600000` (1 hour) | Time between retention passes; `0` disables the timer. The first pass runs 30 s after start. |
| `HUB_COMPACT_BATCH_SIZE` | `100` | Events read, folded and deleted per compaction transaction (at most). |
| `HUB_COMPACT_BATCH_MS` | `10` | Fold time budget per compaction batch; the batch commits what it folded once exceeded. |
| `HUB_COMPACT_MAX_EVENTS` | `1000000` | Events compacted per pass; `0` means no cap. A pass that stops at the cap is followed by another within 60 s, so a backlog drains in chunks instead of one long pass. The `compact` CLI is never capped. |

All numeric variables must be positive integers (`HUB_RETENTION_INTERVAL_MS` and `HUB_COMPACT_MAX_EVENTS` also accept 0); an invalid value stops the hub at start.

Logging is pino JSON on stdout: one line per ingest batch (`count`, `accepted`, `duplicates`, `ms`) and one warn line per reducer exception with the envelope id. Reducer exceptions are bugs. Authorization headers are redacted and query strings are stripped from request logs.

## Migrations

Forward-only and numbered. They live in `src/db/migrations.ts` and are applied in order at start (`store.migrate()`), each in a transaction, recorded in the `schema_migrations` table (`version`, `name`, `applied_at`). A shipped migration is never edited.

| Version | Name             | Contents                                                                                                                                                              |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001     | `initial`        | `hosts`, `events`, `sessions`, `transcript_lines`, `statusline_samples`, `projects`, `layouts`, and the `events_session_ts` and `events_signature` indexes.            |
| 002     | `ingest_indexes` | `events_signature_ts (signature, ts)` for the 5 s duplicate window (replaces `events_signature`, a strict prefix of it) and `sessions_host_state (host, state)`.        |
| 003     | `retention_baselines` | `session_baselines` (one folded snapshot per session), `compaction_state` (single row: the watermark `cut_ts` and a running count), and `statusline_samples_ts` for the bounded sample delete (R2.9). |
| 004     | `baseline_index_and_lease` | `host` and `state` columns on `session_baselines` (backfilled with `json_extract`; the Postgres twin will use `snapshot::json ->> 'host'`), `session_baselines_host_state`, and `hub_lease` (single row, see below). |
| 005     | `dedup_index_by_session` | `events_session_ts_sig (session_id, ts, signature)` replaces `events_signature_ts` and `events_session_ts` (R2.4). See below. |

Migration 005: the 5 s duplicate check used to seek `events(signature, ts)`. A signature is a hash, so each insert touched a random leaf of that index (about half of the ~200 WAL pages a batch of 100 wrote, a third of its CPU). Equal signatures always share a `session_id` (it is part of the hashed material), so the check now seeks `(session_id, ts)` and compares the signature inside the index entries (covering, no table reads; `session_id IS NULL` has its own statement). Inserts append at the tail of a session's range. The new index starts with the columns of `events_session_ts`, so it also serves `WHERE session_id = ? ... ORDER BY seq` exactly as before (checked with `EXPLAIN QUERY PLAN`); both old indexes are dropped. No other query reads `events` by `ts` or `signature`; compaction and replay scan by rowid.

The SQL is written to be valid on both SQLite and Postgres. Two portability rules from the schema in `01-architecture.md` section 5.1 (D-S3-1):

- Epoch-millisecond columns are `BIGINT` (a Postgres `integer` holds at most about 2.1 billion, far below a current millisecond epoch).
- Primary-key columns are `NOT NULL`. `transcript_lines.agent_id` is `''` for the main session, not NULL, because SQLite tolerates NULL in a composite key and Postgres does not.

Where a statement cannot be portable, the rule is two files with the same number, one per engine.

## Ingest contract

`POST /ingest`, `Authorization: Bearer <token>`, `Content-Type: application/json`.

Request body: `{ "host": string, "envelopes": Envelope[] }`, the contract's `IngestRequestSchema`. Every envelope's `host` must equal the body `host`. Response: `{ "accepted": number, "last_seq": number }`.

Limits (D-S3-8, enforced at the boundary, nothing unvalidated reaches the store):

- Body at most 1 MiB (413 `payload_too_large`).
- At most 5000 envelopes per batch (400 `too_many_envelopes`).
- Payload nesting depth at most 64.
- `host`, `session_id`, `agent_id` at most 128 characters; `hook_event_name` at most 64.
- `project_dir` and `cwd` longer than 1024 characters are truncated, not rejected.
- Invalid JSON or schema violations are 400 `invalid_envelope` with a `reason` that never echoes the offending value. Over a rate limit is 429 with an empty body.

One transaction per batch: validate, dedup, insert, reduce, upsert snapshots, then broadcast after commit. A SQL error rolls the whole batch back (500, the probe retries). A reducer exception is logged with the envelope id and counted; the event stays stored.

Dedup, in order:

1. `id` (ULID, primary key) and `(host, seq)` (unique constraint): a repeated envelope is a duplicate.
2. Signature window: a hash of kind, host, session, agent, hook name and canonical payload, with a literal sliding 5 s window. An envelope is a duplicate when a stored envelope has the same signature and a `ts` strictly less than 5000 ms away. There is no fixed time bucket, so two events 1 s apart are never split by a bucket boundary. Signature dedup is a second line of defense against double-fired hooks.

Duplicates are counted in the batch log line, not in `accepted`.

`last_seq` semantics (D-S3-6): `last_seq` is the highest `seq` among the envelopes of this batch, acknowledged whether each was stored or a duplicate. It is not a stored maximum and not a per-host cursor. Probe spool trim rule: after a 2xx response the probe may advance its cursor and trim its spool through the highest `seq` it sent in that batch (which equals `last_seq`); on any non-2xx, timeout or connection error it keeps the batch and retries the same envelopes (idempotent on `id`). It must not treat `last_seq` as a global high-water mark for other batches. The `hosts.last_seq` column is observability only: the highest `seq` ever stored.

Transcript envelopes (`kind: "transcript"`, D-S3-9): the contract has no schema for them yet, so the hub defines the payload as

```json
{ "start_line": 0, "lines": ["<raw jsonl line>", "..."] }
```

`start_line` is a required integer of at least 0; line `i` of `lines` is stored as line number `start_line + i` for `(session_id, agent_id)`, where `agent_id` is the envelope's `agent_id` or `''` for the main session. Re-sent lines are ignored. A payload of any other shape is a reducer exception (logged, counted, event stored). The S2 tailer must emit this shape; the contract owner should add the schema.

## REST routes

All routes except `/health` need `Authorization: Bearer <token>` (scheme matched case-insensitively, token compared in constant time). An unauthenticated request gets 401 with an empty body and `content-length: 0`. No token is accepted in a query string (D-S3-3). Unknown routes are an empty 404. GETs share the read rate limit (429, empty body).

| Route                                                    | Meaning                                                                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                            | `{"ok":true}`, no auth.                                                                                                                                                                                  |
| `POST /ingest`                                           | See above.                                                                                                                                                                                               |
| `GET /sessions?limit=&live=`                             | Snapshots, newest first. `limit` 1 to 1000 (default 200). `live=1` returns the live set: every session not ended or exited, plus ended or exited ones whose end is under 10 minutes old (R2.6); its default limit is 1000, the same as the WS initial message (D-S3-12). |
| `GET /sessions/:id`                                      | One snapshot, or an empty 404.                                                                                                                                                                           |
| `GET /sessions/:id/events?after=&limit=`                 | Raw stored envelopes of the session ordered by `seq`, `seq > after`, `limit` 1 to 1000 (default 1000). An authenticated audit view: payloads are as received, so the R2.7 staleness rule is not applied here (D-S3-11). |
| `GET /sessions/:id/transcript?after=&agent_id=&limit=`   | Raw stored transcript lines `{agent_id, line_no, ts, raw}`, not normalized (the normalizer is S7). `after` is a `line_no` within one agent's numbering, so it requires `agent_id` (400 otherwise); `agent_id=` (empty) is the main session. Without `agent_id`, lines of all agents ordered by `(agent_id, line_no)` (D-S3-13). `limit` 1 to 1000 (default 1000). |
| `GET /projects`                                          | `{ projects }`.                                                                                                                                                                                          |
| `GET /hosts`                                             | `{ hosts }` (host, os, last_seen, last_seq; no secrets).                                                                                                                                                 |

An out-of-range `used_percentage` is nulled when the statusLine is reduced (R2.7). On REST snapshot reads and on every WS message the hub also nulls `used_pct` of a rate-limit window whose `resets_at` has passed, so an idle session never shows a stale percentage (D-S3-7). The contract `SessionSnapshot` has no top-level `ended_at`; the end time is the `sessions.ended_at` column (set from the `SessionEnd` or supersede event time when the state becomes `ended`), which R2.6 uses, falling back to `last_event_at` for `exited` sessions.

Query parameters that fail validation return 400 `invalid_query` with the names of the offending parameters.

## WebSocket `/stream`

`GET /stream` upgraded to WebSocket. Authentication happens before the 101; every refusal is a bare status line with `content-length: 0` and the socket is closed by the hub: 401 (no or wrong credential), 404 (other path), 429 (read rate), 403 (Origin not allowed), 503 (client cap).

Credentials (D-S3-15), either:

- `Authorization: Bearer <token>` (probes, scripts, Node clients), or
- for browsers, which cannot set headers on `new WebSocket`, the subprotocol pair `sessiondeck.v1` and `sessiondeck.bearer.<base64url(token)>`:

```js
const b64 = btoa(token).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const ws = new WebSocket("ws://hub:8787/stream", ["sessiondeck.v1", `sessiondeck.bearer.${b64}`]);
```

The server selects only `sessiondeck.v1`; the bearer subprotocol is never echoed. Both must be offered together.

Messages (server to client, JSON text, `StreamMessage` in the contract):

- `{"type":"initial","sessions":[SessionSnapshot...]}` once, right after connect: the live set (same as `GET /sessions?live=1`).
- `{"type":"session","data":SessionSnapshot}` for every session changed by a committed ingest batch.

A client never misses or double-receives a delta across connect: the initial payload and the join to the broadcast set happen in one synchronous block. A reconnecting client gets a fresh `initial` and no replay of older deltas.

No `transcript` messages are sent until S7 (they are typed as normalized entries, which needs the normalizer); `alert` messages are not sent. Clients send nothing: any client message closes the socket (1003), and incoming frames above 256 bytes are refused.

Limits and liveness: the hub pings every 25 s and terminates a client that did not pong; a client whose send buffer exceeds 4 MiB is terminated; at most `HUB_MAX_WS_CLIENTS` concurrent clients.

R2.5 gate: `pnpm -F @sessiondeck/hub ws:harness` (in-process hub) or `HUB_URL=... HUB_TOKEN=... node packages/hub/scripts/ws-harness.mjs` (a running hub) drives 5 clients and checks that every delta arrives exactly once at every client in under 100 ms and that a reconnect resyncs; `ws:harness:negative` proves the gate can fail.

## Security notes

- Bearer auth on every route except `/health`; 401 bodies carry nothing. The token is compared by SHA-256 digest with `timingSafeEqual`.
- The default bind is `127.0.0.1` (D-S3-4). `01-architecture.md` section 7 says the hub binds the LAN interface; Phase 2 runs on the laptop, so loopback is the safer default and a wider bind is an explicit `HUB_BIND`.
- Rate limits: ingest is limited globally per token and per host with a cap on the number of hosts (D-S3-5); reads and WS upgrades share a per-credential read limit (D-S3-14). All refusals are empty-body 429s.
- Parameterized SQL only. No outbound network calls from the hub at any point.
- The database file is mode 0600 and a directory the hub creates is 0700; payloads and raw transcript lines can hold secrets.
- Accepted risk until per-host tokens exist (D-S3-6): host identity is not bound to a credential, so a token holder can claim another host's name, squat `(host, seq)` pairs so a real probe's envelopes dedup away, or fill the `HUB_MAX_HOSTS` cap with bogus hosts (hosts never age out). Manual recovery for a filled cap, run against the database with the hub stopped, after confirming which hosts are bogus:

  ```sql
  SELECT host, os, last_seen FROM hosts ORDER BY last_seen;
  DELETE FROM events WHERE host = '<bogus host>';
  DELETE FROM hosts WHERE host = '<bogus host>';
  ```

  Sessions created by a bogus host stay in `sessions` until retention exists; remove them with `DELETE FROM sessions WHERE host = '<bogus host>'`.

- `HUB_ALLOWED_ORIGINS` is empty by default in the binary (the compose file sets `http://localhost:5173,http://127.0.0.1:5173`): a browser Origin is not checked, no CORS headers are sent, and only the token blocks cross-site WebSocket hijacking. When non-empty, the list also enables REST CORS on every route except `/ingest` (and `/stream`, which is WS): the exact matching Origin is reflected (never `*`), no credentials header, `Vary: Origin` on every reply, and an allowed-origin preflight answers 204 with methods GET, PUT, PATCH, DELETE, headers `authorization, content-type`, max-age 600 (rate limited, 429). A preflight from any other origin gets no CORS headers (401). When Cloudflare Access (or any other front) puts the hub on a public name in Phase 7, set `HUB_ALLOWED_ORIGINS` to the web UI origin(s), for example `https://deck.example.com`.
- Request logs never contain the Authorization header or query strings.

## Replay and retention

Snapshots (`sessions`, `statusline_samples`) are materialized on ingest. Everything derived can be rebuilt from the stored events, and old events are folded away so the database does not grow without bound.

**`hub replay`** (R2.9): `node dist/main.mjs replay [--db <path>] [--force] [--init]` rebuilds every session snapshot and statusline sample from the events with the same reducer ingest uses, starting from the compaction baselines where they exist. The rebuild is one `BEGIN IMMEDIATE` transaction, so a crash leaves the old snapshots and nothing ingested during it can interleave. It needs no `HUB_TOKEN` and opens no port. Exit codes: 0 ok, 2 usage, missing database or a file that is not a hub database (pass `--init` to initialize one), 3 a hub is serving this database.

**`hub compact`**: `node dist/main.mjs compact [--db <path>] [--force]` runs one retention pass, uncapped. Both commands refuse (exit 3) while the serving hub's lease is fresh: `hub_lease` is one row that the serving hub refreshes every 5 s (expires after 15 s), and it lives in the database, so a crashed hub's lease simply expires. `--force` overrides it, only when you are sure no hub is serving the file.

**Retention** (`src/retention.ts`), run by a timer in `serve` every `HUB_RETENTION_INTERVAL_MS`:

- Statusline samples older than `HUB_SAMPLE_RETENTION_DAYS` are deleted in transactions of 5000 rows.
- Events older than `HUB_EVENT_RETENTION_DAYS` are folded into `session_baselines` and deleted, in transactions of at most `HUB_COMPACT_BATCH_SIZE` events (one `BEGIN IMMEDIATE` each, reading the baselines it folds inside the transaction, so two compactors cannot overwrite each other). Only a prefix of the events table in rowid order is compacted, so baselines plus the remaining events always fold to the `sessions` table and replay order equals ingest order. The watermark `compaction_state.cut_ts` makes ingest treat an envelope older than it as already seen (acknowledged, not stored, counted as `expired` in the response). An event stamped beyond now plus `HUB_MAX_CLOCK_SKEW_MS` is compactable like an old one, so one bad clock cannot freeze compaction.
- **Compaction yields to ingest** (R2.4 must hold while it runs). The server marks every `POST /ingest` in flight (`src/ingest/activity.ts`: a counter and a timestamp, rebuilt empty on restart). Before each batch compaction waits until no ingest request is in flight and none ended in the last 15 ms, but never more than 250 ms per batch, so a saturated hub still drains. After each batch it rests twice the batch's own duration (1 to 50 ms). Every 100 batches it also pauses 150 ms: the checkpoint worker (below) can only let SQLite restart the WAL when it has copied every frame before the next write starts, and back-to-back compaction commits never allowed that, so the writer's safety-net checkpoint ran inline in 23 batches of 20 to 90 ms per 600k events. With the pause that is 2 batches (one at 12 to 23 ms). Offline runs (the CLI) have no ingest to protect and skip the yield and the pause.
- **Per-pass cap**: `HUB_COMPACT_MAX_EVENTS` (default 1,000,000) bounds one pass; a capped pass logs `capped: true` and the timer schedules the next pass in 60 s instead of an hour. Restart backlogs therefore drain in 1M-event chunks (about 70 s each at the measured 15k events/s while ingest runs at 1k/s).
- One `event compaction` log line per pass: `events`, `capped`, `yielded_ms`, `breath_ms`, `forced_batches`, `batches`, `sessions`, `ms`, `max_batch_ms`, `p99_batch_ms`, `slow_batches` (over 10 ms).

### WAL checkpointer

`serve` starts `src/checkpoint.ts` (R2.4). SQLite's default checkpoints inside the commit that grows the WAL past 1000 pages; under `synchronous = NORMAL` that commit fsyncs the WAL and the database file, which stalled one ingest batch in about thirty by 30 to 50 ms and was the whole p95. A worker thread with its own connection now runs `PRAGMA wal_checkpoint(PASSIVE)` every 100 ms (`CHECKPOINT_INTERVAL_MS`) (never overlapping itself: the pragma is synchronous inside a single interval callback), and the writer's automatic checkpoint is raised to 8192 frames as a safety net that bounds the WAL (`journal_size_limit` 64 MiB trims it after a restart). Durability is unchanged. `stop()` (called from the Fastify `onClose` hook before the store closes) asks the worker for a final checkpoint, waits up to 2 s, then terminates it. If the worker cannot start or dies, or fails 100 checkpoints in a row, automatic checkpoints are restored. A failing checkpoint is logged once, then summarised (with a count) at most every 5 minutes, and a recovery is logged. In-memory databases skip it.

## Load harness

`packages/hub/scripts/load-ingest.mjs` (`pnpm -F @sessiondeck/hub load`) proves R2.4. It is open loop: batches go out on a fixed schedule and latency is measured from the scheduled send time to the end of the response, so a stalled hub shows as latency, not as a lower rate. Data comes from `scripts/synth-spool.ts` (the generator `bench-replay.ts` also uses): 2 hosts, golden-session hooks, the captured statusLines, liveness and transcript envelopes, fresh ULIDs and `(host, seq)` each run. The contract defines no spool file format, so there is no `--spool`.

Default target is a real Fastify server on loopback with a real SQLite file under `--dir` (`/tmp/sd-1-S4-load`), built from the same code and pragmas as `serve`; the client shares its event loop, which can only overstate latency.

| Flag | Meaning |
|---|---|
| `--rate 1000 --duration 60 --batch 100` | Sustained mode: envelopes per second, seconds, batch size. A 5 s warm-up (`--warmup`) is excluded from the percentiles. |
| `--speed N [--events 360000] [--span-min 15]` | Replay mode: a synthetic busy day sent at N times real time by envelope `ts`. |
| `--with-retention [--seed-events 600000]` | In-process only. Pre-seeds events older than the retention window, runs a compaction pass during the load, and reports ingest latency during and outside it. |
| `--hot-session` | Sustained mode: every envelope of both hosts goes to ONE `session_id`, the worst case for the `(session_id, ts, signature)` duplicate lookup (about 10k index entries in its 10 s window). Do not combine with `--verify-live`. |
| `--ckpt-ms N` | Checkpoint interval; defaults to `CHECKPOINT_INTERVAL_MS` (100), the value `serve` uses. |
| `--compact-batch N --compact-batch-ms N` | With `--with-retention`: compaction batch size and time budget. |
| `--verify-live` | Afterwards `GET /sessions?live=1` and compare with the sessions created. |
| `--url http://host:8787 --token-file path` | Test a running hub (for example the compose container). The token is never printed. Only `http:` is accepted (the client does not speak TLS, and the bearer token would otherwise cross the network in clear text), and only loopback unless `--allow-insecure` is given. `--spawn` runs the bundled `main.mjs` as a child process. |
| `--p95-limit 20` | Exit 1 when batch p95 exceeds it (ms), when p95 of the batches overlapping the compaction pass exceeds it (`--with-retention`), or any request failed. |

Results (60 s at 1000 envelopes/s in batches of 100, 659 measured batches, 65,900 envelopes, 0 failed requests). Machine: a WSL2 Linux sprint container (20 vCPU, 20 GB), not the Windows laptop. Other sprint sessions share the host and move the numbers: the harness waited for a one-minute load average under 1.0 before each run, and load averages (1, 5, 15 min) before and after each run are listed. Checkpoint interval 100 ms, as `serve`.

Final code, quiet host. "During" is the batches that overlap the compaction pass (about 390 to 420 of 659).

| Run | load before / after | p50 | p95 | p99 | max | Result |
|---|---|---|---|---|---|---|
| Sustained, `--verify-live` (116 of 119 sessions live; the other 3 ended under 10 min before the check) | 0.97 / 0.63 | 8.31 | 12.26 | 16.74 | 35.21 | PASS |
| `--with-retention` 600k backlog, run 1 (pass 42.0 s, 14.3k events/s, 2 batches over 10 ms, max 23.0 ms) | 0.63 / 2.25 | 7.80 | 11.76 | 13.90 | 17.51 | PASS |
| ... during compaction (421 batches) | | 7.25 | 11.45 | 13.49 | 17.51 | |
| ... outside compaction (238) | | 8.33 | 12.08 | 14.12 | 14.70 | |
| `--with-retention`, run 2 (pass 39.0 s, 15.4k/s, max batch 12.4 ms) | 0.98 / 0.57 | 7.84 | 10.95 | 12.29 | 18.36 | PASS |
| ... during compaction (391) | | 6.89 | 10.40 | 12.04 | 18.36 | |
| `--with-retention`, run 3 (pass 39.0 s, 15.4k/s, max batch 20.4 ms) | 0.57 / 0.47 | 8.04 | 11.09 | 12.70 | 15.75 | PASS |
| ... during compaction (391) | | 6.99 | 10.67 | 12.70 | 15.75 | |
| `--hot-session` (one `session_id` for all 1000/s) | 0.47 / 0.21 | 9.60 | 12.88 | 14.41 | 16.00 | PASS |

In all three retention runs the whole 599,984-event backlog drained inside the window ("0 old events left"), with compaction waiting 4.6 to 5.0 s in total for quiet and no forced batch. The duplicate index walk costs about 1 ms at p50 for a single hot session (9.6 against 8.3 ms) and does not threaten the limit, so migration 005 keeps `(session_id, ts, signature)`.

Runs that did not pass, kept for honesty:

| Run | load before / after | p95 | Cause |
|---|---|---|---|
| `--with-retention`, yield without the breath (8 runs) | 0.6 to 1.9 | during compaction 10.2 to 16.2 in six runs, 26.0 and 27.0 in two (one more run failed on overall p95, 20.6, from host noise outside the window) | 18 to 23 compaction batches of 20 to 90 ms: the writer's WAL safety-net checkpoint ran inline (raising it to 32768 frames cut the count to 8 but made one stall 179 ms, so the cause was fixed instead). |
| `--with-retention`, final code, host busy | 1.7 to 3.7 | overall 16.8 / 24.5 / 30.2 / 19.7, during compaction 19.0 / 15.6 / 15.3 / 19.8 | Another session was building images and running tests: batches outside the compaction window were also slow (p95 21 to 47 ms) and compaction showed 5 to 21 batches over 10 ms. Not a hub regression, but it shows the margin shrinks to about zero on a loaded host. |
| Sustained, checkpoint 100 ms, host busy | 1.1 to 3.3 | 18.45, 23.1, 40.1, 43.6 | Same host load (load average 2.4 to 5.4 from a sibling session's Docker builds); reruns on a quiet host gave 11.0 to 15.1 ms. |
| `--hot-session`, host busy | 2.3 to 3.8 | 57.9 (2 sessions), 28.4 | Host load; the quiet-host runs gave 13.4 (2 sessions), 15.3 and 12.9 ms. |
| `--hot-session --verify-live` | | n/a | The verify-live check expects the ended-session mix of the normal run and fails with every envelope in one session; not a latency result. |

Older numbers from the first version of this unit (checkpointer only, no compaction yield): sustained 12.0 to 13.7 ms in process and 12.8 ms against the compose container (`--url`, container IP, named volume, read-only rootfs); `--with-retention` 15.9 overall and 19.6 during compaction in the passing run, 21.3 and 25.6 in a failing one. One sustained run gave 215 ms while a sibling session ran a 200% CPU `tsc` (load average 16). Compose container names are lower-cased by Docker (`sd-1-s4-hub-1`); the container was removed after the run. The compose run was not repeated after the yield and breath changes (they affect only the retention timer).
