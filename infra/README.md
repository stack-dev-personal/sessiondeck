# infra

Phase 2 adds `docker-compose.yml` (hub + web static) for the laptop. Phase 7 adds the box: Postgres, cloudflared, backups, hardening evidence. Owner: sd-executor-infra (compose file shared with sd-executor-hub).

Nothing here runs against a remote host unless the session's handoff names the host and the SSH key is confirmed by the user.

## Laptop compose stack (Phase 2)

`infra/docker-compose.yml` runs the hub and the static web build. Setup:

```
cp infra/.env.example infra/.env && chmod 600 infra/.env     # then set HUB_TOKEN (>= 16 chars)
docker compose -f infra/docker-compose.yml up -d --build
curl http://127.0.0.1:8787/health
```

| Service | Image | Published | Why |
|---------|-------|-----------|-----|
| `hub` | built from `packages/hub/Dockerfile` | `${HUB_BIND:-127.0.0.1}:${HUB_PORT:-8787}` -> 8787 | probe daemon ingest, REST, WS. Loopback by default; a LAN bind is an explicit override in `infra/.env` (set `HUB_ALLOWED_ORIGINS` too) |
| `web` | built from `infra/web/Dockerfile` (nginx-unprivileged, uid 101) | `${WEB_BIND:-127.0.0.1}:${WEB_PORT:-5173}` -> 8080 | static UI with SPA fallback. 5173 matches the dev port; 8080 inside because the server is unprivileged |

- Secrets: only `HUB_TOKEN` (and optional `HUB_*` tuning) in `infra/.env`, read through `env_file`; never a build arg, never in an image layer. Do not run `docker compose config` against the real file in a shared session: it prints it.
- State: SQLite lives in the named volume `hub-data` (`/data`). `docker compose down` keeps it; `down -v` deletes it.
- Hardening on both services: read-only root filesystem (tmpfs `/tmp` only), `no-new-privileges`, all capabilities dropped, non-root users, no Docker socket, `restart: unless-stopped`, healthchecks.
- Hub URL for the web UI is not a build input. The UI takes it at run time (Settings, stored in the browser), so the browser must be able to reach the hub address you enter; `HUB_ALLOWED_ORIGINS` must list the web origin for the WebSocket.
- Images: `node:22-bookworm-slim` and `nginxinc/nginx-unprivileged:1.27-alpine`, pinned by tag, both multi-arch including linux/arm64 (verified with `docker manifest inspect`). Digest pinning is deferred, as in the hub Dockerfile.
- Build context is the repo root and the legacy builder reads only the root `.dockerignore`, which is deny-all with an allow-list. The web build needs the `packages/web/*` and `infra/web/nginx.conf` paths allowed there (the same list is in `infra/web/Dockerfile.dockerignore` for BuildKit).
- Use another project name to run beside other stacks: `docker compose -p <name> ...`; override `HUB_PORT` / `WEB_PORT` if the defaults are taken.
