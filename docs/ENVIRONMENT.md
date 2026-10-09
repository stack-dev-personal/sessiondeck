# Environment

Filled in during S0. Every value here is a fact the planning docs depend on (see `docs/planning/00-open-decisions.md` A2 to A5).

| Fact | Value | How to get it |
|------|-------|---------------|
| Claude Code version | | `claude --version` |
| Plan type | | `/usage` shows 5h/7d bars only on Pro/Max |
| Laptop OS and user | | `systeminfo \| findstr /B /C:"OS Name"`, `echo %USERNAME%` |
| Second machine (if any) | | |
| Git Bash installed | | `where bash` |
| WSL2 used for Claude sessions | | |
| Node version | | `node -v` |
| pnpm version | | `pnpm -v` |
| Windows Terminal version | | `wt -v` |
| Box (Phase 7) OS, Docker version | | |
| agentic-harness hooks registered | | `type %USERPROFILE%\.claude\settings.json` and list the events |
| Hook payload fields observed per event | | from `packages/contract/fixtures/` after S0b |
