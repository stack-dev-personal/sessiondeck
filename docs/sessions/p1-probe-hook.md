# Session log: p1/probe-hook (S1)

- Date: 2026-10-20
- Handoff: docs/handoffs/S01-probe-hook-and-statusline.md
- Sprint: 1 (mvp), base branch sprint/1-mvp at 5b76608
- Contract SHA: 256d2604b86ff12cc080df546792cc430b89e5a4 (ancestor of base: confirmed)
- Requirements: R1.1, R1.2, R1.3, R1.8, R1.9, R1.10

## Task list

| # | Unit | Requirements | Executor | Allowed paths | Blocked by |
|---|------|--------------|----------|---------------|------------|
| U1 | probe scaffold, envelope builder, spool writer, hook entry, esbuild bundles, bench + 50-process stress harness | R1.1, R1.2, R1.3 | sd-executor-probe | packages/probe/** | - |
| U2 | statusline and subagents entries (write-then-render, UTF-8 on Windows) | R1.9 (R1.2 for both) | sd-executor-probe | packages/probe/** | U1 |
| U3 | config/token file, install/uninstall with idempotent settings merge | R1.8, R1.10 | sd-executor-probe | packages/probe/**, docs/PROBE.md | U1 |
| U4 | NOTICE attribution lines, CI confirmation (probe tests on windows-latest) | borrow rules | sd-executor-contract | NOTICE, .github/** | U1, U2, U3 |
| U5 | session close: full suite, verifier over all IDs, docs/VERIFY-P1.md, docs/PROBE-BENCH.md | all | sd-verifier | docs/VERIFY-P1.md, docs/PROBE-BENCH.md | U1-U4 |

Security-gated units (sd-security-reviewer): U3 (settings merge, token file), and U1 (spool contents).

## Decisions made

## Units

## Deferred findings

### Intake decisions (orchestrator, 2026-10-20)
- sd-researcher (2026-10-20): ccstatusline (MIT, Matthew Breedlove, src/utils/windows-code-page.ts: `chcp.com 65001`, windowsHide, ignore failures; ccstatusline.ts @ 3d94211), Claude-Code-Usage-Monitor official.py @ d6e372d (MIT, pid-unique tmp + os.replace), agents-observe @ b3a7238 (MIT, Joe Johnston). Docs: exec form (`command` + `args`, no shell) documented for hooks; statusLine and subagentStatusLine are shell-only; subagentStatusLine output is JSON lines `{id, content}` per row to override, no output keeps default rows; CLAUDE_CONFIG_DIR relocates settings. No contradiction with 00-open-decisions.md.
- Bench lives at packages/probe/scripts/bench-hook.mjs (inside the probe executor's boundary); the handoff's `scripts/bench-hook.mjs` is read relative to the package.
- Spool line = one full contract `Envelope` per line. `seq` assigned by the hook under the spool's advisory lock so it is unique and increasing in file order per host (S2 builds on this).
- On SessionStart the hook also appends a `liveness` envelope `{pid: process.ppid, alive: true}` (CONTRACT.md leaves the first pid report to Phase 1; architecture 4.1 says the hook records it).
- Spool day file named by UTC date.

### U1 (c66c2b2) executor report
- R1.2, R1.3: 50/50 tests pass (3 rounds of 50 parallel hooks, 0 corrupted lines, EnvelopeSchema valid, seq strictly increasing).
- R1.1 in this container (WSL2 Linux x64, Ryzen AI 9 465, node 22.23.3): p95 116.0 / 105.6 / 106.3 ms over three 200-run benches; bare `node -e 0` p95 67 ms on the same machine. Over 80 ms: per handoff constraint, no optimization; A15 question for the user at session end. Laptop bench is the authoritative number (MINI-SPRINT-ORDER needs_laptop).
- NOTICE line needed: agents-observe hook.sh @ b3a7238 (MIT, Joe Johnston) -> packages/probe/src/hook.ts.

### U1 review round 1 (base 5b76608, head c66c2b2)
- sd-reviewer: fix-then-merge. BLOCKING spool.ts lock loop spins forever on EACCES/ENOENT (ignores SIGTERM). MAJOR: stale age < wait (lock theft, duplicate seq); unlocked fallback duplicates seq (breaks S2 R1.4); `.seq` restart from Date.now() makes gaps; host from os.hostname() collides WSL2 vs Windows. MINOR: ppid trust, double envelope build, untested fallback, marker line can exceed 64 KB via long session_id.
- sd-security-reviewer: Gate fail. HIGH same lock spin (planted `.lock` directory DoS). MEDIUM default modes (spool 0644 on Linux), env-controllable SESSIONDECK_HOME/XDG/LOCALAPPDATA redirect + symlink following. LOW lock token, error-log reset follows symlink.
- Reviewer side effect cleaned: test envelope under /home/sprint/.local/state/sessiondeck removed.

### Decision (orchestrator, 2026-10-20): seq moves to the daemon
- The hook no longer takes a lock or keeps a counter. Spool line = contract Envelope without `seq` (type `SpoolLine = Omit<Envelope, "seq">`, exported from packages/probe/src/spool.ts). The daemon (S2), the single reader of the spool, assigns `seq` in file order and persists it with its cursor: zero gaps, zero duplicates by construction (R1.4). Lines stay atomic via one O_APPEND write under 64 KB (R1.3 stress test proves it). Reason: removes the BLOCKING/HIGH lock-spin class and the duplicate/gap paths, and cuts hook latency (R1.1). Supersedes the intake decision "seq assigned by the hook".
- Install writes the resolved probe home and the host name into the registered exec-form args (`--home`, `--host`); the hook and statusline use those, not env vars. Host default: os.hostname(), with `-wsl` suffix inside WSL2, stored in probe.json, overridable at install.
- Impact on S2 (p1/probe-daemon, running in parallel): S2 must parse spool lines as SpoolLine and assign seq. Flag in PR and report.

### U1 fix round 1 (6d5e299)
- Lock and counter removed (D1); SpoolLine/parseSpoolLine exported (src/spool.ts, src/spool-format.ts, src/spool-writer.ts); --home/--host args (D2, D3; host names [A-Za-z0-9._-]); 0700/0600 modes; O_NOFOLLOW day files and error log; ids > 256 chars rejected; 89 tests pass, 1 skipped (Windows ACL, CI).
- Bench (container): p95 85.0 / 84.6 / 87.9 ms, p50 ~67-70 ms. Still > 80 ms; A15 stays with the user.

### U1+U3 review round 2 (5b76608..6d5e299)
- sd-reviewer: fix-then-merge. Round-1 findings all resolved. MAJOR uninstall ENOENT when probe home missing (hooks stay registered). MINOR backup mode follows source (copyFile), probe.json mode not re-checked on same-config reinstall, shellWord leaves `,` `@` unquoted (PowerShell), R1.8 tests use a copy of the contract fixture, stale lock test.
- sd-security-reviewer: Gate pass. MEDIUM CLI honors SESSIONDECK_HOME env (poisoned repo env redirects probe.json and spool into a work tree). LOW backup mode/symlink/never purged; statusLine quoting PowerShell-unsafe chars; icacls by USERNAME not SID, token written on icacls failure, no re-check; install-state.json unvalidated on uninstall.
- All sent back for fixing (cheap to reach).

### U2 statusline/subagents (a4b52f4)
- 142 tests pass, 2 skipped (Windows-only). Format `<model> [effort] | ctx N% | 5h N% | 7d N% [| $cost]`. ccstatusline windows-code-page borrowed into src/win-utf8.ts. Usage-Monitor atomic write not borrowed (no snapshot file is written; install's atomic write is original code). Statusline bench (container): p50 85.9, p95 109.4 ms (not under R1.1).

### U1/U3 fix round 2 (384f251)
- All round-2 findings fixed; 154 pass, 2 skipped. SESSIONDECK_HOME removed from CLI (only --home), install refused under CLAUDECODE unless --allow-inside-claude and refused for a default home in a git work tree; backups 0600 O_EXCL|O_NOFOLLOW, purged on --purge; quoting allowlist [A-Za-z0-9 _./:=+-]; icacls by SID, abort on failure; install-state schema-checked, restore only when equal to the install backup.
- Executor deviation accepted: edited test/units.test.ts (inside packages/probe) to replace the SESSIONDECK_HOME test.

### U2 review round 1 (6d5e299..a4b52f4)
- sd-reviewer: fix-then-merge. BLOCKING chcp.com bare name (cwd search on Windows). MAJOR chcp spawned every tick; MAJOR no state field (R1.9). MINOR surrogate split, partial CSI strip/bidi, stderr assertion.
- sd-security-reviewer: Gate fail. HIGH same chcp.com cwd hijack, no timeout. LOW bidi/zero-width, doc.
- Decision (orchestrator): keep the ccstatusline UTF-8 borrow (handoff asks for it; PowerShell decodes native output with the console code page) but spawn chcp only when the line has non-ASCII and not under Git Bash (MSYSTEM), from an absolute System32 path, cwd System32, timeout 1000, minimal env. R1.9 kept as written: statusline derives a state label from this session's last hook line in the tail of today's spool file.

### U2 fix round 1 (a2d8673)
- chcp absolute System32 path, cwd System32, timeout 1000, env {SystemRoot}, only for non-ASCII lines outside Git Bash; state from last hook line in 64 KB spool tail (mirrors contract reduce() per event; SessionStart → starting); full CSI/OSC/bidi/zero-width strip; code-point truncation. 163 pass, 2 skipped. Statusline bench p95 90.8 (empty spool) / 95.5 ms (70 KB worst case).

### U1/U3 review round 3 (a4b52f4..384f251)
- sd-reviewer: fix-then-merge, no BLOCKING. MAJOR allowlist on statusLine words aborts the whole install (hooks too) for non-ASCII profile paths. MINOR one bad status value drops the whole state entry; uninstall ignores the --home recorded in our hook entries.
- sd-security-reviewer: Gate pass. MEDIUM bare `whoami`/`icacls` (cwd search on Windows). LOW backup path in install-state not constrained to probe home; LOCALAPPDATA env moves CLI default home; uninstall lacks the CLAUDECODE guard.
- Review exit condition met (no BLOCKING). Findings fixed in a final round; the diff is re-reviewed together with U2 round 2.

### Review of 384f251..75e13a2 (U2 round 2, U1/U3 post-round-3 fixes)
- sd-security-reviewer: Gate pass. LOW FIFO day file blocks open (no O_NONBLOCK); inferred uninstall home lacks git-work-tree check; hook default home still reads LOCALAPPDATA (fallback only); SystemRoot env selects System32 (residual); state-reader test gaps.
- sd-reviewer: fix-then-merge. MAJOR Entra ID SIDs (S-1-12-1-) refused; MAJOR state mapping misses Stop→waiting_input after AskUserQuestion/ExitPlanMode and PostCompact-from-idle; MAJOR CI R0.5 60 s budget at risk on Windows. MINORs: yesterday fallback, stale statusLine on skip, --purge with inferred home, chcp gate untested, CSI params, hook.ts copyright line, config show guard test.
- CI run 39357343657 (75e13a2): ubuntu node 22/24 green; windows node 22/24 fail: 10 install tests (temp path RUNNER~1 has `~`, fails the statusLine allowlist; path expectations), icacls ACL test (expects user name, grant is by SID), and the R0.5 step timed out at 60 s.
- Decision (orchestrator): spawn-heavy probe suites (stress, hook robustness, statusline process tests, CLI install) move to a separate budgeted CI step outside R0.5, following decision 13's precedent for guard timing. Probe unit tests stay in the R0.5 step.

### Fix round (70c3241) and CI step (e469d5c)
- Windows causes: 8.3 short temp path `RUNNER~1` failed the word allowlist (now realpath.native and `~` allowed mid-word only); POSIX path expectations in tests; ACL test parsed icacls output wrongly; R0.5 budget. Entra SIDs accepted; statusline state replays a port of reduce() (pair and triple sequences mirrored against contract reduce()); O_NONBLOCK on spool opens; hook default home no longer reads LOCALAPPDATA.
- Test split: `test` 67 tests 2.4 s (in `pnpm -r test`, R0.5); `test:proc` 138 tests (2 skipped) 9.4 s, new CI step with a 5 min budget, job timeout 30 → 35.
- Hook bench (container, this round): p50 43.5, p95 61.1, max 80.5 ms, R1.1 PASS in the container. Earlier runs (106 ms, 85 ms) ran while other agents loaded the machine; the verifier re-measures.

### Final review round (75e13a2..e469d5c)
- sd-reviewer: fix-then-merge, no BLOCKING (review exit met on the third iteration). MAJOR user's statusLine lost in replace, unsafe reinstall, uninstall; MINOR today-whole replay ignored yesterday.
- sd-security-reviewer: Gate pass. LOW USERPROFILE/HOME residual (documented); LOW backup into an inferred home without a record.
- CI run 39358686793: ubuntu green; windows test:proc 3 failures: settings file not removed (8.3 path spelling mismatch in install record; product bug), test expecting LOCALAPPDATA default, probe.json ACL kept explicit SYSTEM ACE (product gap for R1.10).
- Fixed in c311225: all of the above (ACL now removes SYSTEM, Administrators, OWNER RIGHTS ACEs; backups/install-state rely on probe home inheritance on Windows, documented).

### Verification (sd-verifier, c311225)
- docs/VERIFY-P1.md: 6 pass / 0 fail / 0 unverifiable. CI run 39359243907 green on ubuntu and windows, node 22 and 24, including `test probe processes`.
- docs/PROBE-BENCH.md: container hook p95 42.6 / 35.9 / 41.3 ms (bare node p95 25-31 ms). Earlier readings over 80 ms were taken while parallel agents loaded the machine and before the lock was removed. The A15 stop condition is not met on the verified bench; the Windows laptop bench stays authoritative (needs laptop).

## Status at close
- U1 to U4 complete; U5 verification complete. Review loop exited on every unit (final verdict fix-then-merge with no BLOCKING, every finding from that round fixed in c311225); security gate pass on all units.

## Deferred findings
- None open. Accepted residuals documented in docs/PROBE.md: USERPROFILE/HOME moves the default home only for a hook entry without --home; SystemRoot env selects the System32 directory for chcp/whoami/icacls (no new capability over a repo's own settings).

## Notes for S2 (p1/probe-daemon)
- Spool lines carry no `seq`: parse with `parseSpoolLine` / `SpoolLine` from packages/probe/src/spool.ts and assign seq in file order, persisted with the cursor. Read only `*.jsonl` in `<home>/spool`. Home and host come from probe.json (install writes them into hook args).
- SessionStart liveness pid is the hook's ppid; confirm it against ~/.claude/sessions/*.json before trusting it (node shims such as Volta).
