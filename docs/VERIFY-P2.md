# Verification, Phase 2 (hub)

- Branch: p2/hub-core (HEAD d3b4f88)
- Date: 2026-10-20
- Machine: Linux sprint container (WSL2 kernel 6.18.33.2, AMD Ryzen AI 9 465, node v22.23.3)

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R2.8 Bearer token required on every route except /health; missing token gives 401, no body detail | `pnpm -F @sessiondeck/hub test` | 6 files, 34 tests passed (auth.test.ts 13 tests) | pass | 2026-10-20T01:48:36Z |
| R2.8 (live) | start hub with `node --experimental-strip-types packages/hub/src/main.ts` (HUB_PORT=8787, tmp DB, random token), then curl | GET /health no token: 200. GET /sessions, POST /ingest, GET /nonexistent no token: 401, content-length 0. Wrong token on /sessions: 401, content-length 0. Correct token on /nonexistent: 404. Process killed afterwards. | pass | 2026-10-20T01:48:36Z |

Notes: the random live-check token was 31 characters, not 32; this does not affect the result. Tests only exercise routes that exist at this commit; later units must re-check any new route.
