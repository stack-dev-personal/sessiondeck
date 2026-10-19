#!/usr/bin/env node
// sessiondeck PreToolUse guard for Bash.
// Blocks the handful of commands the operating model forbids (docs/planning/04-session-map.md section 1)
// so that "allow Bash" in .claude/settings.json stays safe. Exit 2 blocks the tool and feeds the
// reason back to Claude; exit 0 allows. Never throws: a guard that crashes would block everything.
//
// Time bound. The hook has a 5 s timeout and Claude Code treats a timeout as allow, so a rule that
// can be driven past 5 s is a bypass. The tests time the whole guard at 100k characters, including
// inputs that repeat a rule's anchor (`git push ` x N, `node ` x N, ...), and check growth: the same
// shape at N and 4N must stay well under the 16x of a quadratic (scripts/test/guard.test.ts, growth
// rows). Rule by rule, with the row that tests each claim:
// - Push rules: a start can only be the beginning of the command or a separator (| ; &), and the
//   lookahead finds the FIRST `git push` in that segment once and captures it (a lookahead is
//   atomic in JS, so the engine never retries a later occurrence). The tail then scans the rest of
//   the segment once. Later occurrences are not tried: if one had the flag or main after it, the
//   first occurrence has it after it too. Each segment is scanned by exactly one start.
// - rm rule: the flag token is matched with one deterministic class per letter (the letters before
//   the first r, or before the first f, exclude that letter), so no letter run is rescanned.
// - capture-install --apply: see CAPTURE_NODE below; the flag is checked once per candidate, not
//   once per `node` anchor, the options chain is capped, and every alternation inside it is
//   deterministic (a dash-option token and an option value each have exactly one parse), so a failed
//   match cannot explore 2^k paths. Growth rows: `node --x=node ` x N, the continuation shape,
//   the option-count shape, and the exact `node --a b` x33 commands.
// - git branch, git reset: a fixed literal then a bounded token; tested by the x N rows.
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
// whitespace) followed by an unquoted path prefix without whitespace or braces, or by a quote and a
// quoted prefix that may contain spaces. The rule runs only when the command contains both
// capture-install and --apply (case-insensitive). \x5c is a backslash.
//
// Linear time. CAPTURE_NODE matches a node anchor whose command line continues with at most
// MAX_OPTIONS options and then the script (the shape is a lookahead, so the match is the node part
// only). Each anchor therefore costs a bounded number of tokens. The --apply flag is then checked
// ONCE for that candidate, from the end of the node part to the end of its segment (backslash-newline
// continues a line; | ; & and a bare newline separate). If the flag is missing, every later anchor
// in the same segment has even less text after it, so matching resumes after the segment: each
// segment is scanned at most twice. (Before this, the flag lookahead ran at every anchor, which is
// quadratic on `node ` x N.) More than MAX_OPTIONS options before the script is not recognised.
// Ambiguity is removed on purpose: an option is `-` plus one token class (so `--a` has one parse, not
// `--`+`a` or `-`+`-a`: 2^k paths), and an option value never ends in a backslash that starts a
// backslash-newline (SEP takes it), so `-a x\<LF>` x k has one parse too. Both were exponential.
const MAX_OPTIONS = 32;
const SEP = String.raw`(?:\s|\x5c\r?\n)+`;
const NODE = String.raw`(?:(?:^|[\s;&|(\`{])(?:[^\s|;&"'(){\`]*[\x5c/])?|["'](?:[^"'\n]*[\x5c/])?)(?:node(?:\.exe)?|npx(?:\.cmd)?)["']?`;
const FLAG = String.raw`(?:^|[\s"'=])--apply(?=[\s"'\`);&|<>\x5c]|$)`;
const SEGMENT = String.raw`(?:[^|;&\n]|\x5c\r?\n)*?`;
const VALUE = String.raw`(?:[^\s|;&\x5c]|\x5c(?!\r?\n))+`;
const OPTION = String.raw`(?:${SEP}-[\w.-]+(?:=${VALUE})?(?:${SEP}(?!-)${VALUE})?)`;
const SCRIPT = String.raw`["']?(?:[^\s|;&"']*[\x5c/])?capture-install(?:\.mjs)?(?=[\s"'\`);&|\x5c]|$)`;
const CAPTURE_NODE = new RegExp(`(${NODE})(?=${OPTION}{0,${MAX_OPTIONS}}${SEP}${SCRIPT})`, 'gi');
const FLAG_AFTER = new RegExp(`${SEGMENT}${FLAG}`, 'iy');
const SEGMENT_REST = /(?:\x5c\r?\n|[^|;&\n])*/y;

function captureApply(cmd) {
  CAPTURE_NODE.lastIndex = 0;
  for (let m = CAPTURE_NODE.exec(cmd); m; m = CAPTURE_NODE.exec(cmd)) {
    FLAG_AFTER.lastIndex = CAPTURE_NODE.lastIndex;
    if (FLAG_AFTER.test(cmd)) return true;
    SEGMENT_REST.lastIndex = CAPTURE_NODE.lastIndex;
    SEGMENT_REST.test(cmd);
    CAPTURE_NODE.lastIndex = SEGMENT_REST.lastIndex;
  }
  return false;
}

// `git push` rules: the first `git push` in a segment, found once (see the header), then the tail.
const FIRST_PUSH = String.raw`(?:^|[|;&])(?=([^|;&]*?\bgit\s+push\b))\1`;
const pushRule = (tail, why) => ({ re: new RegExp(`${FIRST_PUSH}[^|;&]*${tail}`), why });

const RULES = [
  pushRule(String.raw`\s(--force|-f|--force-with-lease)\b`, 'force push is forbidden'),
  pushRule(String.raw`\s\+?\S+:(main|master)\b`, 'pushing to main is forbidden; open a PR'),
  pushRule(String.raw`\s(main|master)\b`, 'pushing to main is forbidden; open a PR'),
  { re: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/, why: 'deleting branches is forbidden' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'git reset --hard discards work; stash or ask the user' },
  // The flag token is -<letters> ending in r or f with the other letter before it. The letters
  // before the first r (or f) exclude it, so each letter is matched by one class only.
  { re: /\brm\s+(-[a-qs-zA-Z]*r[a-zA-Z]*f|-[a-eg-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME|\.\.|[A-Za-z]:[\\/])/, why: 'recursive delete outside the repo is forbidden' },
  { re: /[\\/]\.claude[\\/]settings\.json\b/, why: 'the user-level ~/.claude/settings.json is off limits; only the probe installer edits it, in its own tests with CLAUDE_CONFIG_DIR' },
  // Conductor decision 5: the user, from a plain terminal, applies the capture installer.
  // This rule prevents accidents by a well-behaved session. It is not a defence against a hostile
  // one: renamed copies, variables, split quoting, globs and encoded commands get past it, and a
  // compromised session already has the user's privileges. The installer's CLAUDECODE refusal is a
  // second accident check of the same strength. Previews (no flag, or --dry-run) stay allowed.
  { when: (cmd) => { const c = cmd.toLowerCase(); return c.includes('capture-install') && c.includes('--apply'); }, test: captureApply, why: 'capture-install --apply is for the user to run from a plain terminal; previews without --apply are allowed' },
];

function currentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 1500 })
      .toString().trim();
  } catch {
    return null;
  }
}

const matches = (rule, cmd) => (rule.test ? rule.test(cmd) : rule.re.test(cmd));

try {
  const raw = await read();
  const input = raw ? JSON.parse(raw) : {};
  if (input.tool_name !== 'Bash') process.exit(0);
  const cmd = String(input.tool_input?.command ?? '');
  for (const rule of RULES) {
    if ((!rule.when || rule.when(cmd)) && matches(rule, cmd)) {
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
