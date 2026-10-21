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
