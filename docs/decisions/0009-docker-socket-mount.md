# ADR 0009: Sprint containers mount the host Docker socket

Status: accepted 2026-10-15 by the user (S0c open question 1, recorded by the conductor in the Sprint 0 decisions)

## Context
Workers must prove their units with real runtimes: the hub compose stack, a Postgres or Supabase container, a Playwright container. Those run as containers next to the sprint container. The sprint container therefore needs a way to ask a Docker daemon to start them. `infra/sprint/README.md` (section "The docker socket and the container") records the risk of the obvious way to do that.

## Decision
The sprint container mounts the host `/var/run/docker.sock`. Workers start sibling test containers named `sd-<sprint>-<session>-*` and remove them at session end. There is no docker-in-docker.

## Consequences
- The socket is host-root equivalent. A session can `docker exec -u 0` into any container or `docker run --privileged -v /:/host`. On Docker Desktop it also reaches every fixed drive and the WSL filesystems as root on the VM.
- The container is not a sandbox. Sessions run with `--dangerously-skip-permissions`; a prompt-injected sprint session has the user's full laptop privileges. The project deny rules and `guard.mjs` do not cover actions taken through Docker.
- The non-root `sprint` user holds the socket's group (group 0 on Docker Desktop). It exists only because Claude Code refuses `--dangerously-skip-permissions` as root; it is not a security boundary.
- What limits the exposure today, per `infra/sprint/README.md`: nothing that holds against a hostile prompt. `setpriv` with `no_new_privs` and dropped capabilities only stops escalation inside the container; it cannot stop a request to the Docker daemon. The practical limits are procedural: sprints start only when the user runs `scripts/sprint/run-sprint.ps1`, `entrypoint-precheck.sh` allow-lists the container environment, tokens are redacted from the logs the entrypoint writes, and `main` is merged only by the user.
- Anyone who can run docker can read the tokens (`docker run --env-file .sprint/env <image> env`; `docker inspect`), so denying a read of `.sprint/env` does not protect it.
- Mitigations stay optional follow-ups, none built: a socket proxy that refuses binds, `--privileged` and exec; Docker Desktop Enhanced Container Isolation; a dedicated machine for sprints.

## Alternatives rejected
- Docker-in-docker (rootless, one daemon per sprint): a different container setup, not tested here, and sibling containers would live in the inner daemon. Not chosen for the first sprints; it can supersede this ADR.
- Socket proxy now: refused calls would break workers that legitimately need binds or compose. Deferred, not ruled out.
- No Docker for workers: loses the container-based proof of units that the workflow depends on (`PROMPT-BOOK.md` section 2).
