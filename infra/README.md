# infra

Phase 2 adds `docker-compose.yml` (hub + web static) for the laptop. Phase 7 adds the box: Postgres, cloudflared, backups, hardening evidence. Owner: sd-executor-infra (compose file shared with sd-executor-hub).

Nothing here runs against a remote host unless the session's handoff names the host and the SSH key is confirmed by the user.
