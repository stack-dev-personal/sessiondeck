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

const RULES = [
  { re: /\bgit\s+push\b[^|;&]*\s(--force|-f|--force-with-lease)\b/, why: 'force push is forbidden' },
  { re: /\bgit\s+push\b[^|;&]*\s\+?\S+:(main|master)\b/, why: 'pushing to main is forbidden; open a PR' },
  { re: /\bgit\s+push\b[^|;&]*\s(main|master)\b/, why: 'pushing to main is forbidden; open a PR' },
  { re: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/, why: 'deleting branches is forbidden' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'git reset --hard discards work; stash or ask the user' },
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME|\.\.|[A-Za-z]:[\\/])/, why: 'recursive delete outside the repo is forbidden' },
  { re: /[\\/]\.claude[\\/]settings\.json\b/, why: 'the user-level ~/.claude/settings.json is off limits; only the probe installer edits it, in its own tests with CLAUDE_CONFIG_DIR' },
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
    if (rule.re.test(cmd)) {
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
