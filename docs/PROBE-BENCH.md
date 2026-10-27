# Probe bench

## R1.1 hook latency (threshold p95 < 80 ms)

Machine: Linux 6.18.33.2-microsoft-standard-WSL2 x64 (container), AMD Ryzen AI 9 465 w/ Radeon 880M, 20 logical CPUs, node v22.23.3. Not the Windows laptop; the authoritative number is the laptop bench (needs_laptop, decision A15). Date 2026-10-20.

Command: `pnpm -F @sessiondeck/probe build && node packages/probe/scripts/bench-hook.mjs` (200 sequential runs of `node dist/hook.mjs`, PostToolUse fixture on stdin).

| Run | p50 ms | p95 ms | max ms | bad exits |
|---|---|---|---|---|
| 1 | 31.5 | 42.6 | 58.2 | 0 |
| 2 | 29.8 | 35.9 | 49.2 | 0 |
| 3 | 33.6 | 41.3 | 59.9 | 0 |

Baseline, bare node (inline spawnSync loop of `node -e 0`, 200 runs each):

| Run | p50 ms | p95 ms | max ms |
|---|---|---|---|
| 1 | 24.4 | 31.3 | 49.9 |
| 2 | 21.9 | 25.4 | 34.9 |
| 3 | 22.7 | 28.0 | 35.3 |

Hook overhead above bare node is about 8-12 ms at p50. Earlier runs in this session read p95 106 ms (machine loaded by parallel agents), 85 ms, 61 ms; those were noisy and exceed the threshold, so the container result is sensitive to load. These three runs were on a quieter machine.

Result: PASS on the container (3/3 runs under 80 ms). Windows laptop: not yet measured.

## R1.1 Windows laptop, Bun-compiled exe (A15), 2026-10-27

Measurement only; no code, flags or exes were changed or tuned. HEAD 289751f, branch p1/hook-exe.

Machine: Windows 11 Home 10.0.26200 (build 26200), AMD Ryzen AI 9 465 w/ Radeon 880M (20 logical CPUs), node v24.19.0, bun 1.4.4 (pinned dev tool).

Build: `pnpm -F @sessiondeck/probe build && pnpm -F @sessiondeck/probe build:exe`. Compile flags: `--minify --bytecode --no-compile-autoload-dotenv --no-compile-autoload-bunfig`.

Commands (from packages/probe; 200 sequential runs per hook target, 100 per statusline target), interleaved exe / bun-floor for three rounds, then node, then statusline:
`node scripts/bench-hook.mjs --target exe`, `node scripts/bench-hook.mjs --target bun-floor`, `node scripts/bench-hook.mjs --target node`, `node scripts/bench-statusline.mjs --target exe`, `node scripts/bench-statusline.mjs --target node`.

Host state was sampled immediately before each run: containers up (`docker ps`), and one CPU LoadPercentage sample.

| Target | Run | p50 ms | p95 ms | max ms | bad | Containers up | CPU % |
|---|---|---|---|---|---|---|---|
| hook exe | round 1 | 70.2 | 80.5 | 299.0 | 0 | 15 | 39 |
| hook bun-floor | round 1 | 53.7 | 61.9 | 261.2 | 0 | 14 | 45 |
| hook exe | round 2 | 69.3 | 79.6 | 266.8 | 0 | 15 | 68 |
| hook bun-floor | round 2 | 54.9 | 61.8 | 65.6 | 0 | 15 | 34 |
| hook exe | round 3 | 71.7 | 79.9 | 246.7 | 0 | 15 | 56 |
| hook bun-floor | round 3 | 54.9 | 61.3 | 71.3 | 0 | 15 | 45 |
| hook node | single | 121.1 | 136.8 | 275.7 | 0 | 15 | 44 |
| statusline exe | single | 97.3 | 121.0 | 386.6 | 0 | 14 | 4 |
| statusline node | single | 122.4 | 143.6 | 228.8 | 0 | 14 | 19 |

Container names are the same set each run (sprint/dev containers, 7 bb2dash-*, harness-postgres); the count differs by the short-lived sd-3-S10-pw3 / pw4 Playwright containers.

Earlier numbers for context (not produced by this run):
- 2026-10-21 conductor laptop bench: node hook p95 235.2 / p50 152 (200 runs, 0 bad); bare `node -e 0` p95 95.2.
- 2026-10-27 executor first run (14 containers up, CPU 17-57%): node hook 170.1; exe 81.7 (p50 70.4); bun-floor 63.4; exe without --bytecode 95.5; statusline node 459.9; statusline exe 134.3.

Verdict R1.1: FAIL. The rule is that every exe hook run has p95 < 80 ms. Round 1 was 80.5 ms (over); rounds 2 and 3 were 79.6 and 79.9 ms (under, by 0.4 and 0.1 ms). The exe sits on the threshold, with 1 of 3 runs over it, under a loaded host (14-15 containers, CPU 34-68%). The node hook fails clearly (136.8 ms). The statusline exe (121.0 ms) has no stated 80 ms requirement here.

## R1.1 A15 re-bench on the final exe, 2026-10-27 (verifier)

Measurement only (sd-verifier); no code, flags or exes were tuned. Branch p1/hook-exe, HEAD 5614ffb. Rebuilt first with `pnpm -F @sessiondeck/probe build && pnpm -F @sessiondeck/probe build:exe` (the final exe has the pinned autoload flags `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`).

Machine: Windows 11 Home 10.0.26200, AMD Ryzen AI 9 465 w/ Radeon 880M (20 logical CPUs), node v24.19.0, bun 1.4.4 (pinned dev tool). Sprint 3 Docker containers ran beside the bench (count only, from `docker ps -q | wc -l`); CPU % is one Win32_Processor LoadPercentage sample taken just before each run.

Commands (from packages/probe; 200 sequential runs per hook target, 100 per statusline target): `node scripts/bench-hook.mjs --target exe|bun-floor|node`, `node scripts/bench-statusline.mjs --target exe|node`.

| Target | Run | p50 ms | p95 ms | max ms | bad | Containers up | CPU % |
|---|---|---|---|---|---|---|---|
| hook exe | round 1 (first run after rebuild) | 74.8 | 146.6 | 245.8 | 0 | 16 | 40 |
| hook bun-floor | round 1 | 53.7 | 63.8 | 228.8 | 0 | 16 | 26 |
| hook exe | round 2 | 71.9 | 81.2 | 226.4 | 0 | 16 | 52 |
| hook bun-floor | round 2 | 53.8 | 128.4 | 228.8 | 0 | 16 | 49 |
| hook exe | round 3 | 75.8 | 104.7 | 790.0 | 0 | 16 | 90 |
| hook bun-floor | round 3 | 51.7 | 72.8 | 80.1 | 0 | 16 | 54 |
| hook exe | round 4 (extra) | 74.9 | 112.7 | 175.7 | 0 | 16 | 70 |
| hook exe | round 5 (extra) | 67.6 | 95.8 | 246.0 | 0 | 17 | 64 |
| hook node | single | 123.2 | 176.6 | 343.3 | 0 | 17 | 74 |
| statusline exe | single | 103.0 | 127.4 | 321.3 | 0 | 16 | 100 |
| statusline node | single | 131.8 | 155.0 | 218.0 | 0 | 16 | 80 |

All runs: 0 bad exits, 0 bytes on stdout.

Verdict R1.1 (judged at p95 < 100 ms on native Windows, user decision 2026-10-27 option B; see the A15 note in docs/planning/00-open-decisions.md; the original < 80 ms is also shown):
- Earlier three rounds (80.5 / 79.6 / 79.9 ms, HEAD 289751f, before the autoload flags): all three under 100 ms (pass). Against 80 ms: 1 of 3 over, 2 of 3 under by 0.1-0.4 ms.
- New rounds on the final exe (146.6 / 81.2 / 104.7 / 112.7 / 95.8 ms): 2 of 5 under 100 ms, 3 of 5 over (fail). Against 80 ms: 0 of 5 under.
- Combined, 8 exe rounds: 5 under 100 ms, 3 over. The host was noisier than in the earlier rounds (CPU up to 90%, 16-17 containers), and the bun-floor itself spiked to p95 128.4 ms in round 2, so part of the spread is host noise; p50 stayed 67.6-75.8 ms for every exe round. The cause of round 1 (146.6 ms, first run right after the rebuild) was not investigated.
- Result as measured today: FAIL against < 100 ms (partial is fail). This is not a quiet-host number; the A15 note says the conductor runs the quiet-laptop bench with the user before the real install, and that number settles it.
- The Node hook is far over either threshold (p95 176.6 ms). Statusline has no stated threshold: exe 127.4 ms vs Node 155.0 ms.
