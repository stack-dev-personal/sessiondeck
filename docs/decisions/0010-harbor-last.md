# ADR 0010: Harbor last: local-first development, box port and edge at the end

Status: accepted 2026-10-19 by the user (conductor decision 16, recorded in the Sprint 0 decisions)

## Context
The plan ran Phase 7 (harbor: the box, Cloudflare, Supabase Postgres, backups) beside Phases 4 to 6, and put Phase 8 (cockpit) last because the runner needed the auth story from Phase 7. The user answered the order question (decision 16) with: "B. Make cloudflare the last stage of development before migrating. I want to get the ui and functionality working locally with my development sessions before we try to port it to the new box (macbook) and get it to work and display on my machine properly. Rearrange the development sprint order accordingly."

The conductor read the text, not the letter: option B as worded offered bringing Cloudflare forward, and the user's sentence asks for the opposite. Two earlier answers shape the port. Decisions 14 and 14a: the box is an always-on Apple laptop, believed to be an M2 Pro (arm64), so containers on it are linux/arm64. Decision 15: it stays on macOS (no Linux swap), with Docker through a macOS runtime (OrbStack suggested).

## Decision
Everything runs locally on the Windows laptop until the UI and functionality work with real sessions. Harbor moves to the end. Sprint graph: 0 -> 1 -> {2, 3}; 3 -> 5 (cockpit); {2, 3, 5} -> 4 (harbor). Sprint ids and branch names are unchanged (`sprint/4-harbor`, `sprint/5-cockpit`).

- Cockpit (Phase 8, Sprint 5) depends on organize (Sprint 3) only; Phase 8 `depends_on` is [2, 3].
- Harbor (Phase 7, Sprint 4) depends on content, organize and cockpit (Sprints 2, 3, 5); Phase 7 `depends_on` is [2, 4, 5, 6, 8].
- Harbor gains the port to macOS with linux/arm64 images (R7.9) and the runner security re-review (R7.10).

## Consequences
- Phase 8 is built and used against the hub on the laptop (Docker, bound to localhost). Its terminal latency (R8.3) is measured there first and re-measured through the box in harbor.
- Harbor gains two requirements. R7.9: every image in the box compose stack is multi-arch or linux/arm64, and the hub smoke test passes on the box. R7.10: the S13 runner security review is re-run with the hub reachable through Cloudflare Access.
- Roadmap milestones swap: M4 is "I can drive them" (P8), M5 is "It lives on the box" (P7).
- Amends the roadmap order and assumptions A18 and A19 in `docs/planning/00-open-decisions.md` by dated amendment (2026-10-19).
- Supersedes no earlier ADR. ADR 0001 (laptop and box split) and ADR 0003 (Cloudflare edge) still hold; only their timing moves.

## Security note
The runner executes processes on the laptop on request, which is remote code execution by design. S13's security gate is earned with the hub on localhost only: the controls are the hub bearer token and the runner's channel authentication, with no Cloudflare Access in front. While the hub is on the laptop it must stay bound to localhost whenever the runner is enabled.

Exposing the hub through the tunnel changes who can reach the launch path. So before harbor merges, sd-security-reviewer re-reviews the runner with the hub reachable through Access (R7.10), and the conductor re-confirms that gate with the user, as it does for S13.

## Alternatives rejected
- Harbor in parallel after Sprint 1 (the old plan): box work would start before the UI is proven, and against a box OS that was not yet confirmed.
- Bringing Cloudflare forward (option B as worded): the user's text asked for the opposite, Cloudflare as the last stage before migrating.
