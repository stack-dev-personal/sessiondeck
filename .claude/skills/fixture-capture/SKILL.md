---
name: fixture-capture
description: Capture real Claude Code hook, statusLine, and subagentStatusLine payloads from the user's sessions into sessiondeck's contract fixtures, then scrub and commit them. Use in S0 to build the capture script and in S0b to turn a day of raw captures into the fixture suite the reducer and parsers are tested against.
---
# Fixture capture

Why: several hook payload fields are undocumented or version-gated. The reducer, the statusLine schema, and every transcript parser are tested against what Claude Code on the user's machine actually sends, not what the docs say.

## S0: build the capture script
`scripts/capture-fixtures.mjs`, run via exec form so it works on Windows:

- Hook mode: reads stdin, writes `packages/contract/fixtures/raw/<hook_event_name>/<epoch>-<short session id>.json`, exits 0, never writes stdout.
- statusLine mode (`--statusline`): same write under `raw/statusLine/`, then prints one short line so the user's status line keeps working.
- subagentStatusLine mode (`--subagents`): same under `raw/subagentStatusLine/`, prints nothing (empty content hides the rows, which is acceptable for a day).
- `scripts/capture-install.mjs`: merges entries for all 17 events plus `statusLine` and `subagentStatusLine` into `~/.claude/settings.json` without removing existing hooks, writes a backup next to it, and prints the diff. `--uninstall` reverses it from the backup. Test the merge against `packages/contract/fixtures/settings/with-harness-hooks.json` before touching the real file.
- Tell the user: run `node scripts/capture-install.mjs`, work normally for a day across at least two projects, include one long session (so `rate_limits` appears), one session with subagents, one `/compact`, one permission prompt you answer, one AskUserQuestion, one `/clear`, and one session you close by killing the terminal (for liveness fixtures later). Then run `--uninstall`.

## S0b: scrub and commit
1. Inventory: `node scripts/fixture-inventory.mjs` prints a table of event → count → distinct top-level key sets. Any event with zero captures is reported to the user with what to do to trigger it.
2. Scrub, in this order, with a script (`scripts/fixture-scrub.mjs`), never by hand:
   - absolute user paths → `<HOME>/...` (both `C:\Users\<name>` and `/home/<name>` forms, forward and back slashes)
   - anything matching token patterns (`sk-`, `ghp_`, `AKIA`, `xox`, `Bearer `, 32+ char hex or base64 runs) → `<REDACTED>`
   - `last_assistant_message`, `prompt`, `message`, tool inputs and outputs longer than 200 chars → first 120 chars plus `<TRUNCATED n>`
   - emails and account ids → `<EMAIL>`, `<ACCOUNT>`
   - keep every key name and every structural value (session ids may stay; they are not secrets)
3. Select: one representative per distinct key set per event (at least 50 total across at least 12 events), 20 statusLine samples spanning the session (first tick, mid, after compact, with and without `rate_limits`), 5 subagentStatusLine samples.
4. Write `docs/CONTRACT.md` section "Observed payloads": per event, the key set and which fields were optional, plus the Claude Code version.
5. sd-security-reviewer reviews the fixture directory before commit. Gate fail means scrub again; never commit over a fail.
6. Finalize `reduce()` cases marked `TODO(fixture)` and un-skip their tests.

## Later
Whenever `claude --version` changes, re-run the capture for an hour and diff the key sets against `docs/CONTRACT.md`. A new or missing key is a task for sd-executor-contract before anything else is built on that version.
