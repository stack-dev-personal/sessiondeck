# Session log: p1/hook-exe (fix session A15)

- Date: 2026-10-27
- Handoff: conductor fix prompt A15 (PROMPT-BOOK.md section 7 mechanics, branch from main)
- Base: main at cde5b02 (contract commit cde5b026db72d70942a7fb57d9db214e9593bb53)
- Scope: R1.1 (primary); R1.2, R1.3, R1.8, R1.11 must stay passing. No feature work.
- Cause: laptop hook bench 2026-10-21 p95 235.2 ms, p50 152 ms vs < 80 ms; bare `node -e 0` p95 95.2 ms.

## Task list

| # | Unit | Executor | IDs | State |
|---|------|----------|-----|-------|
| U0 | Verify Bun npm install, cross-compile base exe, compile flags | sd-researcher | R1.1, R1.11 | pending |
| U1 | Pin `bun` devDependency for packages/probe, pnpm allowBuilds, lockfile | sd-executor-contract | R1.1 | pending |
| U2 | build-exe script (win x64, linux x64), bench flag, laptop bench (go/no-go) | sd-executor-probe | R1.1, R1.11 | pending, after U1 |
| U3 | `probe install` exec form at the exe, Node-form fallback flag, upgrade test, docs/PROBE.md | sd-executor-probe | R1.8, R1.10, R1.11 | pending, after U2 |
| U4 | R1.2 and R1.3 tests against the exe; CI decision (< 1 min per OS or local only) | sd-executor-probe | R1.2, R1.3 | pending, after U2 |
| U5 | A15 dated note in 00-open-decisions.md | sd-executor-contract | R1.1 | pending, after U2 |
| U6 | Review (sd-reviewer, sd-security-reviewer), verify (sd-verifier) | reviewers, verifier | all | pending |
| U7 | Push p1/hook-exe, PR to main | orchestrator | all | pending |

## Units

## Decisions made

## Deferred findings

### U0 research (sd-researcher), done
- `bun@1.4.4` postinstall (`node install.js`) copies `@oven/bun-<platform>` into `node_modules/bun/bin/bun.exe`; without it `bin/bun.exe` is a placeholder that exits 1. pnpm must allow the build (allowBuilds).
- Cross-compile: `--compile-executable-path <bun binary>` uses a local base instead of a build-time download (download URL and integrity unconfirmed). Plan: get the Linux base from the lockfile-pinned `@oven/bun-linux-x64` optional package.
- Compiled exes autoload `.env` and `bunfig.toml` from the cwd by default; Claude Code runs hooks in the user's project cwd, so compile with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`.
- Bun is MIT; the runtime statically links JavaScriptCore/WebKit (LGPL-2) and tinycc (LGPL-2.1). Private, not redistributed use. No code copied, so no NOTICE line; tool noted in docs/PROBE.md.
- Sources: https://unpkg.com/bun@1.4.4/package.json, https://bun.com/docs/bundler.md, https://bun.com/docs/bundler/executables, https://raw.githubusercontent.com/oven-sh/bun/main/LICENSE.md

### U1 dependency (sd-executor-contract), done, 15b00f4
- `bun` 1.4.4 exact devDependency of @sessiondeck/probe (added by hand: `pnpm add bun` under pnpm 12 is read as a package-manager selection, ERR_PNPM_PACKAGE_MANAGER_IN_SELECTION).
- pnpm-workspace.yaml: `allowBuilds: bun: true`; `supportedArchitectures` os [current, linux], cpu [current, x64], libc [current, glibc] so the lockfile-pinned `@oven/bun-linux-x64` installs on Windows for the WSL2 cross-compile. Side effect: Linux variants of esbuild, rollup, lzma, and both bun linux variants (musl too, host libc reads "unknown") install on Windows; lockfile only gained bun and @oven entries. About 107 MB extra on disk.
- Proof: `pnpm -F @sessiondeck/probe exec bun --version` = 1.4.4; `pnpm install --frozen-lockfile` up to date; probe build ok; probe test 301 passed, 11 skipped.

### U2 build-exe and bench (sd-executor-probe), done, 289751f
- `scripts/build-exe.mjs` (`build:exe`) compiles the esbuild outputs dist/{hook,statusline,subagents}.mjs unchanged with `--minify --bytecode --no-compile-autoload-dotenv --no-compile-autoload-bunfig` into dist/exe/windows-x64/*.exe and dist/exe/linux-x64/* (cross-compiled with `--compile-executable-path` at the pinned Linux base). Also a `bun-floor` hello-world exe.
- Benches gained `--target node|exe|bun-floor` (scripts/bench-target.mjs); temp home, never the real spool or config.
- `scripts/parity-exe.mjs`: 11/11 pass (hook.exe exit 0, 0 stdout bytes on valid, empty, malformed; same spool fields as Node; statusline.exe stdout byte-identical to Node).
- First laptop run (14 containers up incl. sprint-3, CPU 17% before, 57% after): hook node p95 170.1; hook exe p95 81.7 (p50 70.4); bun-floor p95 63.4; statusline node p95 459.9; statusline exe p95 134.3. `--bytecode` compared once: 81.7 vs 95.5 without, kept.
- Exe size about 110 MB each. Linux ELF built, not run (no WSL2 distro besides docker-desktop).
- probe test 301 passed, 11 skipped; typecheck, lint clean.

### R1.1 laptop bench (sd-verifier), FAIL by threshold
- docs/PROBE-BENCH.md new section: hook.exe p95 80.5 / 79.6 / 79.9 ms (3 rounds, 200 runs, 0 bad, 15 containers, CPU 34-68%); bun-floor p95 61.9 / 61.8 / 61.3; node hook p95 136.8; statusline exe 121.0, node 143.6.
- Rule from the handoff: exe misses 80 ms p95, so no tuning; floor recorded; blocked with options in .sprint/1/questions/A15.md.

## Decisions made
- U1 crossed boundary by one line: sd-executor-contract added the `bun` devDependency to packages/probe/package.json, because the lockfile and allowBuilds are root config it owns.
- Benches are recorded by sd-verifier (owner of docs/*-BENCH.md), not the executor.
- Branch not pushed while blocked (keeps Actions minutes; the worktree is local to the conductor's laptop).


### Resume units (2026-10-27)
- U3 exe-form install (sd-executor-probe), d20dc61: exes copied to <home>/bin/<12-hex content hash>/ (temp, SHA-256 check, rename); exec-form hooks; `--runtime node` fallback; install-state records runtime and exeDir.
- U4 exe variants of R1.2/R1.3 (sd-executor-probe), 92f03ac; U4b host-aware build-exe and `build:exe:host`, 537c87d.
- U5 dated notes under A15, A2 and open question 2, and under R1.1/R1.11 in the phase doc (sd-executor-contract), 2196a5a. CI exe step de240b2, 66ae3c7, 6b551de. Format fix 4f3d5af.
- Review round 1: sd-reviewer fix-then-merge (BLOCKING on this log cleared: orchestrator-written; 4 MAJOR, 2 MINOR). sd-security-reviewer Gate: pass (2 MEDIUM, 4 LOW). All fixed in aeb9b2d (install) and b6b6a61 (build/tests).
- Review round 2: sd-reviewer fix-then-merge (2 MAJOR: exe suites in the timing pool, POSIX parent owner; 2 MINOR). Fixed in 7fec9d2; CI runs only `test:proc:exe hook-exe` (6.8 s) to stay under the one-minute rule.
- Review round 3: sd-reviewer **merge** (1 MINOR, stand-in install tests left CI; fixed 5614ffb).
- Verify (sd-verifier), 1ab4ee8: R1.2, R1.3, R1.8, R1.10 pass; R1.11 linux-x64 build pass, WSL2 part not applicable (user); R1.1 FAIL on the loaded host today: hook.exe p95 146.6 (first after rebuild), 81.2, 104.7, 112.7, 95.8 ms with 16-17 containers and CPU 40-90%; bun-floor 63.8 / 128.4 / 72.8 (the floor itself crossed 100 ms, so host load dominates). Earlier rounds 80.5 / 79.6 / 79.9 pass < 100 ms.

## Decisions made (resume, 2026-10-27)
- 2026-10-27, user answer to .sprint/1/questions/A15.md (via the conductor, .sprint/1/answers/A15.md): **option B**. R1.1 on native Windows is judged at hook p95 < 100 ms (the phase doc's SessionEnd ceiling). Recorded as a dated note under A15 in 00-open-decisions.md (original text untouched) and a dated note under the R1.1 line in phase-1-probe.md (line itself untouched). VERIFY-P1 judges the exe against < 100 ms. Session continues as option A: U3, U4, U5, reviews, VERIFY rows, PR. The conductor still runs a quiet-laptop bench with the user before the real install.
- 2026-10-27, user on R1.11/WSL2: "they run on windows with subagents being connected to wsl2 containers for development and testing." Conductor's reading: every Claude Code session runs natively on Windows; WSL2 is only Docker Desktop's backend. Keep the linux-x64 exe build; in VERIFY-P1 mark the WSL2-distro install and bridge part of R1.11 "not applicable to the current setup (user, 2026-10-27)"; add a dated note under A2 / open question 2 in 00-open-decisions.md; delete no R1.11 code or tests.

- Status commands fall back to the Node form when the exe path has a space (statusLine runs under Git Bash or PowerShell; a quoted first word cannot work in both). Hooks stay exe form.
- Accepted the Windows compiler fallback in scripts/bun-resolve.mjs: the postinstall copy of bun.exe is used only when its SHA-256 equals a pin checked against the pnpm store sha512 for @oven/bun-windows-x64@1.4.4; the pin must move with every Bun bump (a test enforces version match).
- CI runs only the hook exe suite (R1.2/R1.3); statusline, subagents, autoload and real-exe install suites run locally (VERIFY-P1, A15 section).
- R1.1 not judged pass from today's loaded bench: the verifier's FAIL stands; the quiet-laptop bench the conductor runs with the user decides it before the real install.

## Deferred findings (resume)
- sd-security-reviewer LOW: Bun runtime env vars (BUN_INSPECT, BUN_OPTIONS, BUN_CONFIG_*) are honored like NODE_OPTIONS; documented in docs/PROBE.md, no code change.
- Leftover %TEMP%sd-install-* folders (about 3.5 GB) from test runs before b6b6a61; not deleted by this session (deletes outside the repo are off limits). The user can remove them.

## Blocked
- 2026-10-27: R1.1 exe p95 at the 80 ms line under load. Question: .sprint/1/questions/A15.md (default A). Resume at U3.
- 2026-10-27: resumed with answer B (see Decisions made, resume).
