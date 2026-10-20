# Verification, Phase 1 (probe)

Branch p1/probe-hook, HEAD c311225. Verified 2026-10-20 (Linux WSL2 container, node v22.23.3). Session S1 rows below; S2 adds R1.4-R1.7.

CI for c311225: run 39359243907, conclusion success. Jobs: windows-latest node 22 success, windows-latest node 24 success, ubuntu-latest node 22 success, ubuntu-latest node 24 success. Each ran the step `test probe processes (R1.2 R1.3 R1.8 R1.9 R1.10, outside R0.5)` with success.

Workspace gates (all exit 0): `pnpm -r typecheck`, `pnpm -r lint`, `pnpm lint:root`, `pnpm format:check`.
`pnpm -r test` (fast suites, wall 11.7 s, R0.5 budget 60 s): scripts 575 passed / 7 skipped (28 files); contract 1090 passed / 1 skipped (28 files); probe 70 passed (4 files).
`pnpm -F @sessiondeck/probe test:proc`: 5 files, 137 passed, 2 skipped (Windows-only: ICACL SID check, win-utf8), 8.5 s.

| Session | ID | Command | Key output | Result | Timestamp |
|---|---|---|---|---|---|
| S1 | R1.1 hook p95 < 80 ms | `pnpm -F @sessiondeck/probe build`; `node packages/probe/scripts/bench-hook.mjs` x3 | p95 42.6 / 35.9 / 41.3 ms (p50 29.8-33.6); bare `node -e 0` p95 25-31 ms. See docs/PROBE-BENCH.md | PASS on container; authoritative number is the Windows laptop bench (needs_laptop, A15), not yet run | 2026-10-20T02:32Z |
| S1 | R1.2 never non-zero, never stdout | `pnpm -F @sessiondeck/probe test:proc` | tests "R1.2 hook never fails and never prints" (empty, closed, not json, array, null, number, invalid utf-8, missing session_id, 1 MB, all fixtures, never-closing stdin 2048 ms, unwritable spool, --home is a file); "R1.2 session and event ids are bounded". All green | PASS; verified by CI (win + ubuntu, step above) | 2026-10-20T02:31Z |
| S1 | R1.3 50 parallel hooks, 0 corrupted | same; `test/stress.proc.test.ts` | "R1.3 spool under 50 parallel hooks" rounds 1, 2, 3: "exact count, every line parses as SpoolLine, unique ids, 0 corrupted lines" (390-424 ms each). Test prints no counts; the assertions are the evidence | PASS; verified by CI | 2026-10-20T02:31Z |
| S1 | R1.8 install keeps harness hooks, idempotent | same; `test/install.proc.test.ts` | "leaves every pre-existing group, matcher, statusLine, permissions and env untouched"; "is idempotent: a second and third run leave a byte-identical file and no new backup"; "uninstall restores a 2-space file byte for byte"; "malformed settings are refused". Fixture with-harness-hooks.json is loaded through packages/probe/test/fixtures/sandbox.ts | PASS; verified by CI | 2026-10-20T02:31Z |
| S1 | R1.9 statusLine one-liner, never throws | same; `test/statusline.proc.test.ts` | "R1.9 statusline fixtures" 12-first-tick ... 20-first-tick, 5h n/a cases; "robustness (both entries)" empty/closed/malformed/array/invalid utf-8/1 MB all exit 0 with fallback line. 20 of 20 statusLine fixture tests present and green | PASS; verified by CI | 2026-10-20T02:31Z |
| S1 | R1.10 config outside settings, 0600/0700, token not leaked | same; `test/config.proc.test.ts`, `install.proc.test.ts` | "writes probe.json outside the settings directory; the token is nowhere else"; "probe.json is 0600 and the probe home is 0700 on POSIX"; "rejects the token as an argument, without echoing it"; "config show masks the token"; "never leaves the token in the registered hook args". Windows ICACL test skipped on Linux, ran on windows CI step (success) | PASS; Windows part verified by CI | 2026-10-20T02:31Z |

Count: 6 pass / 0 fail / 0 unverifiable (R1.1 laptop number outstanding).
