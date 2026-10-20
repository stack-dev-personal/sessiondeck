# Verification, Phase 2 (hub)

- Branch: p2/hub-core (HEAD d3b4f88; R2.1 to R2.3 rows verified at 337e5d2)
- Date: 2026-10-20
- Machine: Linux sprint container (WSL2 kernel 6.18.33.2, AMD Ryzen AI 9 465, node v22.23.3)

| Requirement | Command | Key output | Result | Timestamp |
|---|---|---|---|---|
| R2.8 Bearer token required on every route except /health; missing token gives 401, no body detail | `pnpm -F @sessiondeck/hub test` | 6 files, 34 tests passed (auth.test.ts 13 tests) | pass | 2026-10-20T01:48:36Z |
| R2.8 (live) | start hub with `node --experimental-strip-types packages/hub/src/main.ts` (HUB_PORT=8787, tmp DB, random token), then curl | GET /health no token: 200. GET /sessions, POST /ingest, GET /nonexistent no token: 401, content-length 0. Wrong token on /sessions: 401, content-length 0. Correct token on /nonexistent: 404. Process killed afterwards. | pass | 2026-10-20T01:48:36Z |
| R2.1 Ingest validates and rejects malformed envelopes with 400 and a reason; accepts batches up to 1 MB | `pnpm -F @sessiondeck/hub test` | 11 files, 153 tests passed. ingest-validation.test.ts (14 tests, "R2.1 validation": missing field, bad kind, bad ULID, wrong version, host mismatch, not an array, invalid JSON, nothing stored on reject, "accepts a body of exactly 1 MiB; 1 byte more is a 413"); ingest-hardening.test.ts "D-S3-8 bounds" (5001 envelopes 400, depth 65 400, string caps) | pass | 2026-10-20T02:13:00Z |
| R2.1 (live) | `pnpm -F @sessiondeck/hub bundle`, `node dist/main.mjs` (HUB_PORT=8787, tmp HUB_DB_PATH, 32-char random token), curl POST /ingest | malformed: 400 `{"error":"invalid_envelope","reason":"envelopes[0].id: Required"}`. Valid 1048575-byte body: 200 `{"accepted":1,"last_seq":1}`. 1048577-byte body: 413 `{"error":"payload_too_large"}`. Hub killed, /health unreachable afterwards. | pass | 2026-10-20T02:13:00Z |
| R2.2 Duplicate `id` or identical signature within 5 s is accepted (200) but not stored twice | `pnpm -F @sessiondeck/hub test` | ingest-dedup.test.ts 10 tests passed ("R2.2 dedup": same id across and within batches, same (host, seq), signature 4.9 s vs 5.1 s, bucket boundary, out-of-order, key order); ingest-hardening.test.ts "indexes" signature range seek | pass | 2026-10-20T02:13:00Z |
| R2.2 (live) | same hub; POST a 2-envelope batch twice, read `select count(*) from events` via better-sqlite3 readonly | 1st POST: 200 accepted 2, events 1 -> 3. 2nd identical POST: 200 `{"accepted":0,"last_seq":11}`, events stays 3. | pass | 2026-10-20T02:13:00Z |
| R2.3 Replaying Phase 0 fixture sequences yields snapshots equal to golden files | `pnpm -F @sessiondeck/hub test` | ingest-golden.test.ts 52 tests passed ("R2.3 golden replay over HTTP"; 5 golden files in test/golden: all-kinds, all-statuslines, fixture-mix, golden-session, supersede; each replayed at several batch sizes in plain, interleaved-dups and resent-after modes; "committed golden file equals a fresh oracle fold"; "covers every envelope kind"; timeline match). Total run: 153 passed, 0 failed. | pass | 2026-10-20T02:13:00Z |

Notes: the random live-check token was 31 characters, not 32; this does not affect the result. Tests only exercise routes that exist at this commit; later units must re-check any new route.
