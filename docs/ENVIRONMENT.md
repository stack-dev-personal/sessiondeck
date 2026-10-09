# Environment

Filled in during S0. Every value here is a fact the planning docs depend on (see `docs/planning/00-open-decisions.md` A2 to A5).

| Fact | Value | How to get it |
|------|-------|---------------|
| Claude Code version | 2.1.295 | `claude --version` |
| Plan type | pending user | `/usage` shows 5h/7d bars only on Pro/Max |
| Laptop OS and user | Windows 11 Home 10.0.26200, user `stack` | `systeminfo \| findstr /B /C:"OS Name"`, `echo %USERNAME%` |
| Second machine (if any) | pending user | |
| Git Bash installed | yes, `C:\Program Files\Git\usr\bin\bash.exe` | `where bash` |
| WSL2 used for Claude sessions | pending user | |
| Node version | v24.19.0 local (CI and `.nvmrc` use 22; `engines.node` is `>=22`) | `node -v` |
| pnpm version | 12.10.1 (pinned in root `packageManager`); npm 11.17.0 | `pnpm -v` |
| Windows Terminal version | 1.24.12741.0 (`wt -v` printed nothing in Git Bash; read from the installed package via `Get-AppxPackage Microsoft.WindowsTerminal`) | `wt -v` |
| Box (Phase 7) OS, Docker version | pending user (box OS). Laptop Docker 29.8.1, gh 2.101.0 | |
| agentic-harness hooks registered | pending user (sessions may not read the user-level settings file) | `type %USERPROFILE%\.claude\settings.json` and list the events |
| Hook payload fields observed per event | pending (S0b) | from `packages/contract/fixtures/` after S0b |
