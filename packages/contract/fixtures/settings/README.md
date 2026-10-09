# Settings fixtures

`with-harness-hooks.json` is SYNTHETIC. It was invented for tests and is not derived from any real
Claude Code settings file. It models a user who already runs another tool's hooks: existing groups
on PreToolUse (with a matcher), PostToolUse, Stop and SessionEnd (shell-form commands pointing at a
made-up script), an existing `statusLine`, a `permissions` block, and an `env` block whose values
are obvious fakes. Paths use `<HOME>` placeholders.

Used by `scripts/test/capture-install.test.ts` to prove that `scripts/capture-install.mjs` merges
without disturbing existing entries and that `--uninstall` restores the file exactly. Tests copy
it into a temp directory; nothing ever points at a real settings file.
