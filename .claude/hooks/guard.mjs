#!/usr/bin/env node
// sessiondeck PreToolUse guard for Bash.
// Blocks the handful of commands the operating model forbids (docs/planning/04-session-map.md section 1)
// so that "allow Bash" in .claude/settings.json stays safe. Exit 2 blocks the tool and feeds the
// reason back to Claude; exit 0 allows. Never throws: a guard that crashes would block everything.
import { execSync } from 'node:child_process';

const read = () => new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', () => resolve(data));
});

// capture-install --apply: node, node.exe or npx (optionally quoted, optionally a full path that may
// contain spaces) after the start, whitespace, { ( a quote, a backtick or a separator, so env
// prefixes, pnpm exec, time, then and cmd /c all count. Then the capture-install script as its
// first non-option argument (node options with a value, such as -r x, are skipped) and a standalone
// --apply flag in the same command, before or after the script. The flag must be followed by
// whitespace, a quote, a closer, a redirect or the end, so --apply-later is not matched. A command
// that merely quotes the whole node line (grep, echo, commit message) is blocked too: fail closed,
// listed as known false positives in the tests. The start is a single anchor character (no repeated
// whitespace, so matching stays linear on long runs) followed by an unquoted path prefix without
// whitespace, or by a quote and a quoted prefix that may contain spaces. The rule runs only when the
// command contains both capture-install and --apply (case-insensitive). \x5c is a backslash.
const SEP = String.raw`(?:\s|\x5c\r?\n)+`;
const NODE = String.raw`(?:(?:^|[\s;&|(\`{])(?:[^\s|;&"'()\`]*[\x5c/])?|["'](?:[^"'\n]*[\x5c/])?)(?:node(?:\.exe)?|npx(?:\.cmd)?)["']?`;
const FLAG = String.raw`(?:^|[\s"'=])--apply(?=[\s"'\`);&|<>\x5c]|$)`;
const SEGMENT = String.raw`(?:[^|;&\n]|\x5c\r?\n)*?`;
const OPTION = String.raw`(?:${SEP}--?[\w.-]+(?:=[^\s|;&]+)?(?:${SEP}(?!-)[^\s|;&]+)?)`;
const SCRIPT = String.raw`["']?(?:[^\s|;&"']*[\x5c/])?capture-install(?:\.mjs)?(?=[\s"'\`);&|\x5c]|$)`;
const CAPTURE_APPLY = new RegExp(`${NODE}(?=${SEGMENT}${FLAG})${OPTION}*${SEP}${SCRIPT}`, 'i');

const RULES = [
  { re: /\bgit\s+push\b[^|;&]*\s(--force|-f|--force-with-lease)\b/, why: 'force push is forbidden' },
  { re: /\bgit\s+push\b[^|;&]*\s\+?\S+:(main|master)\b/, why: 'pushing to main is forbidden; open a PR' },
  { re: /\bgit\s+push\b[^|;&]*\s(main|master)\b/, why: 'pushing to main is forbidden; open a PR' },
  { re: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/, why: 'deleting branches is forbidden' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'git reset --hard discards work; stash or ask the user' },
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME|\.\.|[A-Za-z]:[\\/])/, why: 'recursive delete outside the repo is forbidden' },
  { re: /[\\/]\.claude[\\/]settings\.json\b/, why: 'the user-level ~/.claude/settings.json is off limits; only the probe installer edits it, in its own tests with CLAUDE_CONFIG_DIR' },
  // Conductor decision 5: the user, from a plain terminal, applies the capture installer.
  // This rule prevents accidents by a well-behaved session. It is not a defence against a hostile
  // one: renamed copies, variables, split quoting, globs and encoded commands get past it, and a
  // compromised session already has the user's privileges. The installer's CLAUDECODE refusal is a
  // second accident check of the same strength. Previews (no flag, or --dry-run) stay allowed.
  { when: (cmd) => { const c = cmd.toLowerCase(); return c.includes('capture-install') && c.includes('--apply'); }, re: CAPTURE_APPLY, why: 'capture-install --apply is for the user to run from a plain terminal; previews without --apply are allowed' },
];

function currentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 1500 })
      .toString().trim();
  } catch {
    return null;
  }
}

try {
  const raw = await read();
  const input = raw ? JSON.parse(raw) : {};
  if (input.tool_name !== 'Bash') process.exit(0);
  const cmd = String(input.tool_input?.command ?? '');
  for (const rule of RULES) {
    if ((!rule.when || rule.when(cmd)) && rule.re.test(cmd)) {
      process.stderr.write(`sessiondeck guard: ${rule.why}. Command: ${cmd}\n`);
      process.exit(2);
    }
  }
  // Bare `git push` while on main pushes main. Block that too.
  if (/\bgit\s+push\b/.test(cmd) && !/\bgit\s+push\s+\S+\s+\S+/.test(cmd)) {
    const branch = currentBranch(input.cwd || process.cwd());
    if (branch === 'main' || branch === 'master') {
      process.stderr.write(`sessiondeck guard: you are on ${branch}; create a p<phase>/<slug> branch and push that.\n`);
      process.exit(2);
    }
  }
  process.exit(0);
} catch {
  process.exit(0);
}
