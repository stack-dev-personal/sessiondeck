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

## Blocked
- 2026-10-27: R1.1 exe p95 at the 80 ms line under load. Question: .sprint/1/questions/A15.md (default A). Resume at U3.
