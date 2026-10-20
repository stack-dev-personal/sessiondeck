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
| `HUB_ALLOWED_ORIGINS`   | empty                           | Comma-separated Origin allow-list for WS upgrades. When non-empty, an upgrade carrying any other Origin is refused (403). See security. |

All numeric variables must be positive integers; an invalid value stops the hub at start.

Logging is pino JSON on stdout: one line per ingest batch (`count`, `accepted`, `duplicates`, `ms`) and one warn line per reducer exception with the envelope id. Reducer exceptions are bugs. Authorization headers are redacted and query strings are stripped from request logs.

## Migrations

Forward-only and numbered. They live in `src/db/migrations.ts` and are applied in order at start (`store.migrate()`), each in a transaction, recorded in the `schema_migrations` table (`version`, `name`, `applied_at`). A shipped migration is never edited.

| Version | Name             | Contents                                                                                                                                                              |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001     | `initial`        | `hosts`, `events`, `sessions`, `transcript_lines`, `statusline_samples`, `projects`, `layouts`, and the `events_session_ts` and `events_signature` indexes.            |
| 002     | `ingest_indexes` | `events_signature_ts (signature, ts)` for the 5 s duplicate window (replaces `events_signature`, a strict prefix of it) and `sessions_host_state (host, state)`.        |

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

- `HUB_ALLOWED_ORIGINS` is empty by default: a browser Origin is not checked, and only the token blocks cross-site WebSocket hijacking. When Cloudflare Access (or any other front) puts the hub on a public name in Phase 7, set `HUB_ALLOWED_ORIGINS` to the web UI origin(s), for example `https://deck.example.com`.
- Request logs never contain the Authorization header or query strings.

## Replay and retention

Scope: S3 delivers the ingest path, the environment variables and the migrations. `hub replay` (rebuild snapshots from stored events, R2.9) and event retention are owned by S4 and are not implemented here. Until then snapshots are materialized on ingest only, and no data is deleted by the hub.
