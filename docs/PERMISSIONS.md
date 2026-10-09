# Permissions

What a session is allowed to do in this repo, why, and how to widen it per phase. Project settings live in `.claude/settings.json` (committed). Personal overrides go in `.claude/settings.local.json` (ignored).

## Current policy

| Rule | Effect | Why |
|------|--------|-----|
| `defaultMode: acceptEdits` | file edits inside the repo need no prompt | the executor loop edits constantly; the branch is the safety net |
| allow `Bash` | any shell command runs without a prompt | you asked for it; the guard hook and deny list carry the few hard limits |
| deny `git push --force*`, `git push -f*`, `git push origin main*`, `git push origin HEAD:main*` | blocked before the hook runs | main is merged by you through PRs |
| deny `git branch -D*`, `git reset --hard*` | blocked | work is never discarded by an agent |
| deny `Read(./.env)`, `Read(./.env.*)`, `Read(./**/probe.json)` | secrets unreadable to sessions | tokens never enter a transcript (transcripts leave the laptop in Phase 4) |
| allow `WebFetch` on the doc domains listed | sd-researcher can verify docs | everything else stays offline |
| `PreToolUse` guard hook on `Bash` | `.claude/hooks/guard.mjs` blocks force push, push to main (including bare `git push` while on main), branch delete, reset --hard, recursive delete outside the repo, and any command touching `~/.claude/settings.json` | deny rules are prefix patterns and cannot see the current branch; the hook can |

Verify once in S0 that the exec-form hook resolves `${CLAUDE_PROJECT_DIR}` on your Windows build (run any Bash tool call with `claude --debug` and look for the guard in the hook log). If it does not, switch the hook to shell form: `"command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard.mjs\""`.

Also set branch protection on GitHub for `main` (require PR, no force push, no deletion). Local guards protect against mistakes; the server rule protects against everything.

## Widening per phase

Phase 7 and any Supabase work: when the backend moves to Supabase, add the Supabase MCP server to the project and grant it fully by adding to `permissions.allow`:

```json
"mcp__supabase__*"
```

or, if you want the MCP server itself wired at project level, add `.mcp.json` at the repo root (committed) with the Supabase server entry, and keep the access token in your user-level config, never in the repo. Then give `sd-executor-hub` and `sd-executor-infra` the tool by adding `mcp__supabase__*` to their `tools:` frontmatter (a subagent with an explicit `tools:` list gets nothing it does not name).

Phase 7 Cloudflare: add `WebFetch(domain:developers.cloudflare.com)` (already present) and, if you use the Cloudflare MCP server, `mcp__cloudflare__*`.

Phase 8 runner: nothing new in Claude Code permissions; the runner's own allow-list of project roots is the control.

## What stays forbidden regardless of settings

Pushing to `main`, force pushes, deleting branches, editing the user-level `~/.claude/settings.json`, running anything against the box without the host and key confirmed in the handoff. These are also written into every agent's instructions, so a session that somehow bypasses the hook still knows the rule.
