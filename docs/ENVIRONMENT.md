# Environment

Filled in during S0. Every value here is a fact the planning docs depend on (see `docs/planning/00-open-decisions.md` A2 to A5).

| Fact | Value | How to get it |
|------|-------|---------------|
| Claude Code version | 2.1.295 | `claude --version` |
| Plan type | Max (decision 11, user, 2026-10-19) | `/usage` shows 5h/7d bars only on Pro/Max |
| Laptop OS and user | Windows 11 Home 10.0.26200, user `stack` | `systeminfo \| findstr /B /C:"OS Name"`, `echo %USERNAME%` |
| Second machine (if any) | MacBook, Apple M2 Pro (arm64), macOS Sonoma, being set up now; it is also the box | user answer, decisions 14, 15, 17 (2026-10-19) |
| Git Bash installed | yes, `C:\Program Files\Git\usr\bin\bash.exe` | `where bash` |
| WSL2 used for Claude sessions | yes: Claude sessions run in WSL2 on the Windows laptop; hooks fire inside WSL2 with Linux paths. Native Windows sessions are also supported; both are required in Phase 1 (conductor's call, the user has not confirmed the mix) | user answer, decision 17; conductor's call, decision 19 (2026-10-19) |
| Node version | v24.19.0 local (CI and `.nvmrc` use 22; `engines.node` is `>=22`) | `node -v` |
| pnpm version | 12.10.1 (pinned in root `packageManager`); npm 11.17.0 | `pnpm -v` |
| Windows Terminal version | 1.24.12741.0 (`wt -v` printed nothing in Git Bash; read from the installed package via `Get-AppxPackage Microsoft.WindowsTerminal`) | `wt -v` |
| Box (Phase 7) OS, Docker version | Box: MacBook (M2 Pro, arm64), macOS Sonoma, stays on macOS; Docker runtime chosen at harbor, OrbStack suggested; containers linux/arm64. Box Docker version: pending, set at harbor. Laptop Docker 29.8.1, gh 2.101.0 | user answer, decisions 14a, 15, 17 (2026-10-19) |
| agentic-harness hooks registered | SessionStart, SubagentStop, SessionEnd at user level. The probe install adds its own entries beside them and never disturbs them | user's PowerShell listing, event names only, decision 18 (2026-10-19) |
| Hook payload fields observed per event | S0b done; see `packages/contract/fixtures/` and the "Observed payloads" section of `docs/CONTRACT.md` | `packages/contract/fixtures/`, `docs/CONTRACT.md` |
