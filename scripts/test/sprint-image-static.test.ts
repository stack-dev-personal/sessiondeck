import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findPosixShell, runShellCases, type ShellCaseResult } from "./helpers-sprint-shell";

// Static checks only (no docker, so they fit the 60 second CI budget). The
// container behavior is proven by infra/sprint/test/check-sprint-image.sh.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sprintDir = join(repoRoot, "infra", "sprint");

const TOKEN_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"];
const TOKEN_ALTERNATION = TOKEN_NAMES.join("|");

function read(...parts: string[]): string {
  return readFileSync(join(sprintDir, ...parts), "utf8");
}

const entrypoint = read("entrypoint.sh");
const precheck = read("entrypoint-precheck.sh");
const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const override = read("test", "docker-compose.test.yml");
const harness = read("test", "check-sprint-image.sh");

// One git spawn answers every "checked out with LF" test in this file.
const EOL_PATHS = ["infra/sprint/entrypoint.sh", "infra/sprint/entrypoint-precheck.sh"];
let eolAttributes: string[] | undefined;
function eolLine(path: string): string {
  if (eolAttributes === undefined) {
    const result = spawnSync("git", ["check-attr", "eol", ...EOL_PATHS], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    eolAttributes = result.stdout.split(/\r?\n/);
  }
  return eolAttributes.find((line) => line.startsWith(`${path}:`)) ?? "";
}

const SH = findPosixShell("sh");
const BASH = findPosixShell("bash");
// A security test that cannot run must not pass as "skipped" in CI.
const inCi = Boolean(process.env.CI);
if (inCi && (SH === undefined || BASH === undefined)) {
  throw new Error(
    `CI is set but no working POSIX shell was found (sh: ${SH ?? "none"}, bash: ${BASH ?? "none"}); the entrypoint security tests cannot be skipped in CI`,
  );
}
if (SH === undefined)
  console.warn("SKIPPED: no working POSIX sh was found; pre-stage tests skipped");
if (BASH === undefined) console.warn("SKIPPED: no working bash was found; id rule test skipped");
const itSh = it.skipIf(SH === undefined);
const itBash = it.skipIf(BASH === undefined);

describe("sprint entrypoint", () => {
  it("starts with the bash shebang and contains no CR bytes", () => {
    expect(entrypoint.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(entrypoint).not.toContain("\r");
  });

  it("is checked out with LF line endings", () => {
    expect(eolLine("infra/sprint/entrypoint.sh")).toMatch(/: eol: lf$/);
  });

  it("fails fast and never traces or dumps the environment", () => {
    expect(entrypoint).toMatch(/^set -Eeuo pipefail$/m);
    expect(entrypoint).not.toMatch(/set\s+-[a-z]*x/);
    expect(entrypoint).not.toMatch(/set\s+-o\s+xtrace/);
    expect(entrypoint).not.toMatch(/\bprintenv\b/);
    expect(entrypoint).not.toMatch(/^\s*env\s*(\||$)/m);
    expect(entrypoint).not.toMatch(/\b(export|declare)\s+-p\b/);
  });

  it("never echoes the value of a token variable", () => {
    const printing = new RegExp(
      `^\\s*(echo|printf|log|die)\\b.*\\$\\{?(${TOKEN_ALTERNATION})\\b`,
      "m",
    );
    expect(entrypoint).not.toMatch(printing);
  });

  it("refuses the API credentials that would override the subscription token", () => {
    expect(entrypoint).toMatch(/refuse_var ANTHROPIC_API_KEY/);
    expect(entrypoint).toMatch(/refuse_var ANTHROPIC_AUTH_TOKEN/);
  });

  it("lifts the headless background-task ceiling before running claude", () => {
    // A real top-level statement (line start, value exactly 0), not a comment or a nested line.
    const exports = [...entrypoint.matchAll(/^export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0$/gm)];
    expect(exports).toHaveLength(1);
    expect(entrypoint).not.toMatch(/CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=[^0\s]/);
    const exportAt = exports[0]?.index ?? -1;
    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(entrypoint.indexOf('claude -p "$('));
    // After the privilege drop, so the re-exec'd stage 2 process sets it for every claude child.
    expect(exportAt).toBeGreaterThan(entrypoint.indexOf("exec setpriv"));
  });

  it("runs the documented headless command", () => {
    expect(entrypoint).toContain("--agent");
    expect(entrypoint).toContain(
      "--dangerously-skip-permissions --output-format stream-json --verbose",
    );
    expect(entrypoint).not.toContain("--bare");
  });

  it("has no test-only switch for choosing the binary", () => {
    expect(entrypoint).not.toMatch(/stub/i);
    expect(compose).not.toMatch(/stub/i);
  });

  it("logs the reason when a step fails under set -e", () => {
    const logFileAt = entrypoint.indexOf('LOG_FILE="$STATE_DIR/logs/entrypoint.log"');
    const trapAt = entrypoint.indexOf('trap \'report_failure "$?" "$LINENO"\' ERR');
    expect(logFileAt).toBeGreaterThan(-1);
    expect(trapAt).toBeGreaterThan(logFileAt);
    expect(entrypoint).toContain('log "failed at line $line with status $status"');
  });

  it("names the failing repository step and logs a fixed hint, never git's own output", () => {
    // Each step name is set right before its git commands run.
    const stepAt = (step: string, command: string) => {
      const at = entrypoint.indexOf(`setup_step=${step}\n`);
      expect(at, step).toBeGreaterThan(-1);
      expect(entrypoint.indexOf(command, at), `${step} -> ${command}`).toBeGreaterThan(at);
      return at;
    };
    const fetchAt = stepAt("fetch", "fetch --quiet --prune origin");
    const cloneAt = stepAt("clone", "git clone --quiet");
    const checkoutAt = stepAt("checkout", "symbolic-ref --short refs/remotes/origin/HEAD");
    expect(fetchAt).toBeLessThan(checkoutAt);
    expect(cloneAt).toBeLessThan(checkoutAt);
    // Cleared once the checkout is done, so a later failure gets no clone hint.
    expect(entrypoint.indexOf('setup_step=""\n', checkoutAt)).toBeGreaterThan(checkoutAt);
    expect(entrypoint).toContain(
      'readonly HINT_CLONE_OR_FETCH="check that GH_TOKEN has access to this repository, SPRINT_REPO_URL, and the network"',
    );
    expect(entrypoint).toContain(
      'readonly HINT_CHECKOUT="check the /work checkout on the reused volume (local changes, origin/HEAD) or docker volume rm sprint-<id>-work"',
    );
    expect(entrypoint).toContain("clone | fetch) hint=$HINT_CLONE_OR_FETCH ;;");
    expect(entrypoint).toContain("checkout) hint=$HINT_CHECKOUT ;;");
    expect(entrypoint).toContain(
      'log "failed at line $line with status $status during $setup_step: $hint"',
    );
    // git's stderr goes to docker logs only: no git command is redirected into the log file.
    const gitLines = entrypoint.split("\n").filter((l) => /^\s*git\b/.test(l));
    expect(gitLines.length).toBeGreaterThan(0);
    for (const line of gitLines) {
      expect(line).not.toMatch(/LOG_FILE|entrypoint\.log|2>&1|redact_stream/);
    }
    const reportAt = entrypoint.indexOf("report_failure() {");
    const reportBody = entrypoint.slice(reportAt, entrypoint.indexOf("\n}\n", reportAt));
    expect(reportBody).not.toMatch(/\bgit\b|stderr|2>/);
  });

  it("installs the stop handler at the start of stage 2, before any clone", () => {
    expect(entrypoint).toMatch(/trap on_stop_signal TERM INT/);
    const trapAt = entrypoint.indexOf("trap on_stop_signal TERM INT");
    expect(trapAt).toBeGreaterThan(entrypoint.indexOf("exec setpriv"));
    expect(trapAt).toBeLessThan(entrypoint.indexOf("git config --global"));
    expect(trapAt).toBeLessThan(entrypoint.indexOf("git clone"));
  });

  it("checks the stopping flag before the clone and before launching claude", () => {
    expect(entrypoint).toMatch(/on_stop_signal\(\) \{\n {2}stopping=1\n {2}forward_signal\n\}/);
    const checks = [...entrypoint.matchAll(/^exit_if_stopping$/gm)].map(
      (match) => match.index ?? 0,
    );
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(entrypoint.indexOf("git clone"));
    expect(checks[1]).toBeGreaterThan(entrypoint.indexOf("# --- Run the level-1 prompt headless"));
    expect(checks[1]).toBeLessThan(entrypoint.indexOf('claude -p "$('));
  });

  it("forwards SIGTERM to claude, also when it arrives during launch, and keeps its exit status", () => {
    expect(entrypoint).toMatch(/forward_signal\(\) \{[^}]*kill -TERM "\$claude_pid"/s);
    expect(entrypoint).toMatch(
      /claude_pid=\$!\n(?:#[^\n]*\n)+if \[ "\$stopping" -eq 1 \]; then\n {2}forward_signal/,
    );
    expect(entrypoint).toMatch(/wait "\$claude_pid" \|\| rc=\$\?/);
    expect(entrypoint).toContain("readonly EXIT_STOPPED=143");
  });

  it("no longer carries the allow-list, which moved to the pre-stage", () => {
    expect(entrypoint).not.toContain("refuse_unlisted_environment");
    expect(entrypoint).not.toContain("ALLOWED_ENV_NAMES");
    expect(entrypoint).toContain("entrypoint-precheck.sh");
  });

  it("passes claude's stdout and stderr through the token filter before tee or docker logs", () => {
    expect(entrypoint).toMatch(/redact_stream <"\$out_fifo" \| tee "\$SESSION_LOG"/);
    expect(entrypoint).toMatch(/redact_stream <"\$err_fifo" >&2/);
    expect(entrypoint).toMatch(/>"\$out_fifo" 2>"\$err_fifo" &/);
    // the claude command no longer pipes straight into tee
    expect(entrypoint).not.toMatch(/--verbose\s*\|\s*tee/);
  });

  it("reads the secrets for the filter from the environment, never from argv", () => {
    const filter = /redact_stream\(\) \{[\s\S]*?\n\}\n/.exec(entrypoint)?.[0] ?? "";
    expect(filter).toContain('ENVIRON["CLAUDE_CODE_OAUTH_TOKEN"]');
    expect(filter).toContain('ENVIRON["GH_TOKEN"]');
    expect(filter).not.toMatch(/-v\s+\w+="?\$\{?(CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN)/);
    expect(filter).toContain("index(line, secret)");
    expect(filter).not.toMatch(/gsub|sub\(|match\(/);
  });

  it("states that the non-root user is not a security boundary", () => {
    expect(entrypoint).toContain("NOT a security boundary");
    expect(entrypoint).toContain("root-equivalent");
    expect(entrypoint).not.toContain("grants nothing beyond the socket");
    expect(entrypoint).not.toContain("can regain root");
  });
});

// Names set by ENV instructions, including continuation lines, with their values.
function envPairsFrom(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  let inEnv = false;
  for (const line of text.split("\n")) {
    if (/^ENV\s/.test(line)) inEnv = true;
    if (inEnv) {
      for (const match of line.matchAll(
        /(?:^ENV\s+|^\s+)([A-Za-z_][A-Za-z0-9_]*)=(\S+?)(?:\s*\\)?$/g,
      )) {
        pairs.set(match[1] ?? "", match[2] ?? "");
      }
      inEnv = line.trimEnd().endsWith("\\");
    }
  }
  return pairs;
}

// The names whose value the pre-stage pins, with the shell variable that holds it.
const PINNED_PATH_VALUE = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PINNED_NAMES = [
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "GIT_TERMINAL_PROMPT",
  "GH_PROMPT_DISABLED",
];

describe("sprint pre-stage (entrypoint-precheck.sh)", () => {
  const block = /# BEGIN env-checks\n([\s\S]*?)# END env-checks/.exec(precheck)?.[1] ?? "";

  // Every case runs as a function in the shared shell of ONE process (runShellCases), so a test
  // with many entries costs a single process start. Cases must end with `return`, never `exit`. check_entry sets `refused`, which survives the loop
  // because the loop is not in a pipe; each case starts from refused=0.
  const SHELL = SH ?? "sh";
  const REFUSED_STATUS = 64;
  const cases = (bodies: string[]): ShellCaseResult[] => runShellCases(SHELL, block, bodies);
  const entriesBody = (entries: string[]): string => {
    const quoted = entries.map((entry) => `'${entry}'`).join(" ");
    return `refused=0
for line in ${quoted}; do check_entry "$line"; done
[ "$refused" -eq 0 ] || return ${REFUSED_STATUS}`;
  };
  /** One case per entry list. */
  const runEntries = (lists: string[][]): ShellCaseResult[] => cases(lists.map(entriesBody));
  /** One case per single entry, in order. */
  const eachEntry = (entries: string[]): ShellCaseResult[] =>
    runEntries(entries.map((entry) => [entry]));

  // The real conversion: environ_to_entries on a NUL-separated stream, then the
  // checker. The payload is printf %b text (a backslash-zero separates entries).
  const environBody = (payload: string): string => `refused=0
entries=$(printf '%b' '${payload}' | environ_to_entries)
check_environment_text "$entries"
[ "$refused" -eq 0 ] || return ${REFUSED_STATUS}`;

  it("is POSIX sh with LF endings, the image entrypoint, and execs the bash entrypoint last", () => {
    expect(precheck.startsWith("#!/bin/sh\n")).toBe(true);
    expect(precheck).not.toContain("\r");
    expect(precheck).not.toMatch(/\[\[|^\s*local\s|<<<|\bmapfile\b|\$\{[A-Za-z_]+\/\//m);
    expect(precheck).toMatch(/^set -eu$/m);
    expect(precheck.trimEnd().endsWith('exec "$BASH_ENTRYPOINT" "$@"')).toBe(true);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/sprint-precheck"\]$/m);
    expect(precheck).toContain("BASH_ENTRYPOINT=/usr/local/bin/sprint-entrypoint");
  });

  it("is checked out with LF line endings", () => {
    expect(eolLine("infra/sprint/entrypoint-precheck.sh")).toMatch(/: eol: lf$/);
  });

  it("reads this shell's own environment and stops if it cannot", () => {
    expect(precheck).toContain("ENVIRON_FILE=/proc/$$/environ");
    expect(precheck).not.toContain("/proc/self/environ\n");
    expect(precheck).toMatch(/environment_lines=\$\(environ_to_entries <"\$ENVIRON_FILE"\)/);
    expect(precheck).toContain("tr '\\n\\0' '\\001\\n'");
    expect(precheck).not.toContain("can only refuse more");
    expect(precheck).toContain("could not read the process environment");
  });

  it("resets PATH before the first external command", () => {
    const resetAt = precheck.indexOf("PATH=$PINNED_PATH\nexport PATH");
    expect(resetAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(precheck.indexOf("environment_lines=$(environ_to_entries"));
  });

  it("never prints a value and neutralises unusual names", () => {
    expect(precheck).not.toMatch(/printf[^\n]*\$value/);
    expect(precheck).not.toMatch(/\becho\b/);
    expect(precheck).toContain("<name with unusual characters>");
  });

  it("pins the same values as the Dockerfile ENV block and the node base image PATH", () => {
    const dockerEnv = envPairsFrom(dockerfile);
    for (const name of PINNED_NAMES) {
      const value = dockerEnv.get(name);
      expect(value, `Dockerfile ENV ${name}`).toBeDefined();
      expect(precheck).toContain(`PINNED_${name}=${value}\n`);
    }
    expect(precheck).toContain(
      "PINNED_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n",
    );
  });

  itSh(
    "allows the tokens, SPRINT_*, and every name the Dockerfile sets with ENV",
    () => {
      const dockerEnv = envPairsFrom(dockerfile);
      const names = [...dockerEnv.keys(), ...TOKEN_NAMES, "SPRINT_ID"];
      expect(names.length).toBeGreaterThan(5);
      const results = eachEntry(
        names.map(
          (name) => `${name}=${PINNED_NAMES.includes(name) ? (dockerEnv.get(name) ?? "") : "x"}`,
        ),
      );
      names.forEach((name, i) => expect(results[i]?.status, name).toBe(0));
    },
    30_000,
  );

  itSh("accepts a clean environment", () => {
    const [result] = runEntries([
      [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "CLAUDE_CODE_OAUTH_TOKEN=x",
        "GH_TOKEN=y",
        "SPRINT_ID=0",
        "_=/usr/bin/setpriv",
        "HOME=/home/sprint",
        "BASH_ENV=",
        "LD_PRELOAD=",
      ],
    ]);
    expect(result?.status).toBe(0);
    expect(result?.output).toBe("");
  });

  itSh("refuses anything that could redirect the token or run code", () => {
    const entries = [
      "ANTHROPIC_API_KEY=x",
      "ANTHROPIC_AUTH_TOKEN=x",
      "ANTHROPIC_BASE_URL=https://h.invalid",
      "NODE_OPTIONS=--require=/x.js",
      "HTTPS_PROXY=http://p.invalid",
      "GIT_CONFIG_COUNT=1",
      "LD_LIBRARY_PATH=/x",
      "LD_AUDIT=/x.so",
      "LD_DEBUG_OUTPUT=",
      "LD_DEBUG_OUTPUT=/x",
      "BASH_FUNC_exit%%=() { :; }",
    ];
    const results = eachEntry(entries);
    entries.forEach((entry, i) => expect(results[i]?.status, entry).toBe(REFUSED_STATUS));
  });

  itSh("accepts BASH_ENV and the pinned LD_* names only when empty", () => {
    const empty = ["BASH_ENV=", "LD_PRELOAD=", "LD_AUDIT=", "LD_LIBRARY_PATH="];
    const withValue = [
      "LD_AUDIT=/state/x/a.so",
      "LD_LIBRARY_PATH=/state/x/lib",
      "BASH_ENV=/state/x/evil.sh",
      "BASH_ENV=$(echo MARKER)",
      "LD_PRELOAD=/state/x/evil.so",
    ];
    const [accepted, ...refused] = runEntries([empty, ...withValue.map((entry) => [entry])]);
    expect(accepted?.status).toBe(0);
    withValue.forEach((entry, i) => expect(refused[i]?.status, entry).toBe(REFUSED_STATUS));
  });

  itSh("refuses an entry whose value has a newline, whatever follows it", () => {
    const tail = "\\nSPRINT_$(echo MARKER)";
    const heads = [
      ["BASH_ENV", ""],
      ["LD_PRELOAD", ""],
      ["PATH", PINNED_PATH_VALUE],
      ["HOME", "/home/sprint"],
      ["SPRINT_ID", "0"],
    ] as const;
    const results = cases(heads.map(([name, head]) => environBody(`${name}=${head}${tail}\\0`)));
    heads.forEach(([name], i) => {
      const result = results[i];
      expect(result?.status, name).toBe(REFUSED_STATUS);
      expect(result?.output, name).toContain(name);
      expect(result?.output, name).toContain("newline");
      expect(result?.output, name).not.toContain("MARKER");
    });
  });

  itSh("accepts a NUL-separated clean environment through the same conversion", () => {
    const [result] = cases([
      environBody(`PATH=${PINNED_PATH_VALUE}\\0BASH_ENV=\\0LD_AUDIT=\\0SPRINT_ID=0\\0`),
    ]);
    expect(result?.status).toBe(0);
    expect(result?.output).toBe("");
  });

  itSh("refuses a pinned name whose value differs from the image value", () => {
    const entries = [
      "CLAUDE_CONFIG_DIR=/state/x/cfg",
      "HOME=/root",
      "PATH=/state/x/bin:/usr/bin",
      "DISABLE_AUTOUPDATER=0",
      "GIT_TERMINAL_PROMPT=1",
      "GH_PROMPT_DISABLED=0",
    ];
    const results = eachEntry(entries);
    entries.forEach((entry, i) => expect(results[i]?.status, entry).toBe(REFUSED_STATUS));
  });

  itSh("names the variable and never the value, and tells the user where to look", () => {
    const [result] = runEntries([
      [
        "ANTHROPIC_BASE_URL=https://secret-value-host.invalid",
        "BASH_FUNC_id%%=() { :; }",
        "LD_PRELOAD=/secret-value.so",
        "CLAUDE_CONFIG_DIR=/secret-value/cfg",
      ],
    ]);
    expect(result?.status).toBe(REFUSED_STATUS);
    expect(result?.output).toContain("ANTHROPIC_BASE_URL");
    expect(result?.output).toContain("LD_PRELOAD");
    expect(result?.output).toContain("CLAUDE_CONFIG_DIR");
    expect(result?.output).toContain("BASH_FUNC_id%%");
    expect(result?.output).toContain(".sprint/env or the Docker proxy settings");
    expect(result?.output).not.toContain("secret-value");
  });

  itSh("does not print terminal escape sequences from a hostile name", () => {
    const [result] = runEntries([["BAD\u001b]52;c;x\u0007NAME=1"]]);
    expect(result?.status).toBe(REFUSED_STATUS);
    expect(result?.output).not.toContain("\u001b");
    expect(result?.output).toContain("<name with unusual characters>");
  });
});

describe("sprint Dockerfile", () => {
  it("has no ARG or ENV naming a token or an overriding credential", () => {
    const declarations = dockerfile
      .split("\n")
      .filter((line) => /^\s*(ARG|ENV|LABEL)\b/.test(line) || /^\s+\w+=/.test(line))
      .join("\n");
    const names = [...TOKEN_NAMES, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "apiKeyHelper"];
    for (const name of names) {
      expect(declarations).not.toContain(name);
    }
  });

  it("does not reference .sprint", () => {
    expect(dockerfile).not.toMatch(/\.sprint\b/);
  });

  it("pins the base image by tag and digest", () => {
    expect(dockerfile).toMatch(/^FROM node:22\.23\.3-bookworm@sha256:[0-9a-f]{64}$/m);
  });

  it("verifies the GitHub CLI keyring against both published fingerprints", () => {
    expect(dockerfile).toContain("gpg --show-keys --with-colons /etc/apt/keyrings/githubcli.gpg");
    expect(dockerfile).toContain("2C6106201985B60E6C7AC87323F3D4EA75716059");
    expect(dockerfile).toContain("7F38BBB59D064DBCB3D84D725612B36462313325");
    expect(dockerfile).toContain("exit 1");
    const verifyAt = dockerfile.indexOf("gpg --show-keys");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(
      dockerfile.indexOf("apt-get install -y --no-install-recommends gh"),
    );
  });

  it("pins pnpm to the root packageManager version", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      packageManager: string;
    };
    const pnpmArg = /^ARG PNPM_VERSION=(.+)$/m.exec(dockerfile);
    expect(rootPackage.packageManager).toBe(`pnpm@${pnpmArg?.[1]}`);
  });

  it("pins Claude Code and disables auto-update", () => {
    expect(dockerfile).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toContain("DISABLE_AUTOUPDATER=1");
  });

  it("copies only the two entrypoint files and ignores everything else", () => {
    const copies = dockerfile.split("\n").filter((line) => /^\s*COPY\b/.test(line));
    expect(copies).toHaveLength(2);
    expect(copies.join("\n")).toContain("COPY entrypoint.sh ");
    expect(copies.join("\n")).toContain("COPY entrypoint-precheck.sh ");
    const ignore = read(".dockerignore").split("\n");
    expect(ignore).toContain("*");
    expect(ignore).toContain("!entrypoint.sh");
    expect(ignore).toContain("!entrypoint-precheck.sh");
  });
});

describe("sprint compose file", () => {
  it("declares the work volume, the state bind mount and the docker socket", () => {
    expect(compose).toMatch(/^\s+- work:\/work$/m);
    expect(compose).toMatch(/:\/state\/\$\{SPRINT_ID\}$/m);
    expect(compose).toMatch(/^\s+- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/m);
    expect(compose).toMatch(/name: sprint-\$\{SPRINT_ID\}-work/);
  });

  it("reads tokens through an overridable env_file", () => {
    expect(compose).toMatch(/env_file:\s*\n\s+- \$\{SPRINT_ENV_FILE:-\.\.\/\.\.\/\.sprint\/env\}/);
  });

  it("does not interpolate either token", () => {
    for (const name of TOKEN_NAMES) {
      expect(compose).not.toMatch(new RegExp(`\\$\\{?${name}\\b`));
      expect(override).not.toMatch(new RegExp(`\\$\\{?${name}\\b`));
    }
  });

  it("leaves the stub to the test override only", () => {
    expect(override).toContain("HARNESS_STUB");
    expect(override).toContain("/usr/local/sbin/claude");
  });

  it("says the socket is root-equivalent and the container is not a boundary", () => {
    expect(compose).toContain("root-equivalent");
    expect(compose).toContain("not a security boundary");
  });

  it("pins the code-running names to empty and the image-owned names to their image values", () => {
    const block = /\n {4}environment:\n([\s\S]*?)\n {4}volumes:/.exec(compose)?.[1] ?? "";
    expect(block).toMatch(/^\s+BASH_ENV: ""$/m);
    expect(block).toMatch(/^\s+LD_PRELOAD: ""$/m);
    expect(block).toMatch(/^\s+LD_AUDIT: ""$/m);
    expect(block).toMatch(/^\s+LD_LIBRARY_PATH: ""$/m);
    const dockerEnv = envPairsFrom(dockerfile);
    for (const name of PINNED_NAMES) {
      expect(block, name).toMatch(new RegExp(`^\\s+${name}: "?${dockerEnv.get(name)}"?$`, "m"));
    }
    expect(block).toMatch(
      /^\s+PATH: \/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m,
    );
  });

  it("says the loader acts on any LD_* name before the check, and which ones compose pins", () => {
    expect(compose).toContain("loader acts on any LD_* name before the pre-stage can look");
    expect(precheck).toContain("acts on any");
    expect(precheck).toContain("(LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH)");
    expect(compose).not.toContain("applies LD_PRELOAD before");
  });

  it("describes the pins as protection against mistakes, not against a writer of .sprint/env", () => {
    expect(compose).toContain("not a defense against someone who can write");
    expect(precheck).toContain("not a defense against someone who can write .sprint/env");
  });

  it("gives the test container no environment the pre-stage would refuse", () => {
    expect(override).not.toMatch(/GIT_CONFIG/);
    expect(override).toContain("/etc/gitconfig");
  });
});

describe("sprint container harness", () => {
  it("uses its own compose project, never sprint-<id>", () => {
    expect(harness).toMatch(/readonly COMPOSE_PROJECT=sd-0-s0c-harness$/m);
    expect(harness).toContain('docker compose -p "$COMPOSE_PROJECT"');
    expect(harness).not.toMatch(/COMPOSE_PROJECT=sprint-/);
  });

  it("builds every path for native tools in Windows form", () => {
    expect(harness).toMatch(/^here="\$\(to_native /m);
    expect(harness).toMatch(/^sprint_dir="\$\(to_native /m);
    expect(harness).toMatch(/^repo_root="\$\(to_native /m);
    expect(harness).toMatch(/^tmp_dir="\$\(to_native "\$\(mktemp/m);
    expect(harness).not.toMatch(/\$tmp_native/);
  });

  it("does not change file modes of tracked files", () => {
    expect(harness).not.toMatch(/chmod \+x/);
    expect(harness).toContain("require_executable_stub");
  });

  it("fails instead of passing when a checked file is missing or a command fails", () => {
    expect(harness).toContain("expect_clean()");
    expect(harness).toContain("file missing or empty");
    expect(harness).toContain("capture_or_fail");
    expect(harness).not.toMatch(/\|\| : >/);
  });

  it("requires the literal authentication failure for the non-root real binary", () => {
    expect(harness).toContain(
      `readonly AUTH_PATTERN='"error":"authentication_failed"|Not logged in'`,
    );
    expect(harness).toMatch(/-ne 126.*-ne 127/s);
  });

  it("clears per-run artifacts and proves the output filter and the allow-list", () => {
    expect(harness).toContain('"$state_dir/logs/sprint.jsonl"');
    expect(harness).toContain("expect_marker");
    expect(harness).toContain("ANTHROPIC_BASE_URL not on the allow-list");
  });

  it("probes BASH_ENV with a command substitution and an exported exit function, asserting the marker never appears", () => {
    expect(harness).toContain("BASH_ENV with a command substitution");
    expect(harness).toContain("BASH_FUNC_exit%%=() {");
    expect(harness).toContain("hostile code never ran");
    expect(harness).toContain('grep -qF -e "$forbidden"');
  });

  it("probes a changed CLAUDE_CONFIG_DIR and PATH and a valued LD_PRELOAD", () => {
    expect(harness).toContain('run_guard "CLAUDE_CONFIG_DIR changed"');
    expect(harness).toContain('run_guard "PATH changed"');
    expect(harness).toContain('run_guard "LD_PRELOAD with a value"');
  });

  it("drives docker stop at a sleeping stub and requires status 143 in entrypoint.log", () => {
    expect(harness).toContain("check_10_sigterm");
    expect(harness).toContain('docker stop -t "$STOP_GRACE_S"');
    expect(harness).toContain("claude exited with status $SIGTERM_EXIT");
    expect(harness).toMatch(/^readonly SIGTERM_EXIT=143$/m);
  });

  it("selects the stub's sleep mode by prompt text, with no new variable and no production switch", () => {
    const stub = read("test", "claude-stub.sh");
    expect(stub).toContain('"${2:-}" = "$SLEEP_PROMPT"');
    expect(stub).toContain("exec sleep");
    expect(harness).toMatch(/^readonly SLEEP_PROMPT="stub: sleep until stopped"$/m);
    expect(stub).toContain('readonly SLEEP_PROMPT="stub: sleep until stopped"');
    expect(override).not.toMatch(/SLEEP/i);
  });

  it("probes newline tails, and LD_AUDIT and LD_LIBRARY_PATH through the env file and docker run -e", () => {
    for (const name of ["BASH_ENV", "LD_PRELOAD", "PATH"]) {
      expect(harness).toContain(`"${name} with a newline and SPRINT_ tail"`);
    }
    expect(harness).toContain("newline_tail=$'\\n''SPRINT_$(echo '");
    expect(harness).toContain("run_pin_wins LD_AUDIT");
    expect(harness).toContain("run_pin_wins LD_LIBRARY_PATH");
    expect(harness).toContain('"LD_AUDIT with a value (docker run -e)"');
    expect(harness).toContain('"LD_LIBRARY_PATH with a value (docker run -e)"');
  });

  it("checks the pre-stage with shellcheck as POSIX sh", () => {
    expect(harness).toContain("-s sh -x /mnt/entrypoint-precheck.sh");
  });
});

describe("sprint id rule: entrypoint and PowerShell scripts agree", () => {
  const commonScript = readFileSync(
    join(repoRoot, "scripts", "sprint", "lib", "sprint-common.ps1"),
    "utf8",
  );
  const powershellPattern = /^\$SprintIdPattern = '([^']+)'$/m.exec(commonScript)?.[1] ?? "";
  const ruleBlock = /^if ! \[\[ \$SPRINT_ID =~ (\S+) \]\]; then\n {2}die [^\n]*\nfi$/m.exec(
    entrypoint,
  );
  const bashPattern = ruleBlock?.[1] ?? "";

  // Runs the entrypoint's own `if ! [[ ... ]]; then die` block with a stub die that records
  // the verdict, one function call per id inside a single bash process.
  function entrypointVerdicts(ids: string[]): Array<"accepted" | "refused"> {
    const rule = ruleBlock?.[0] ?? "return 99";
    const bodies = ids.map(
      (id) => `SPRINT_ID='${id}'
verdict=accepted
die() { verdict=refused; }
${rule}
echo "$verdict"`,
    );
    return runShellCases(BASH ?? "bash", "", bodies).map((result, i) => {
      expect(result.status, `bash exit for ${JSON.stringify(ids[i])}: ${result.output}`).toBe(0);
      return result.output.trim() === "accepted" ? "accepted" : "refused";
    });
  }

  it("finds both rules", () => {
    expect(powershellPattern).not.toBe("");
    expect(ruleBlock).not.toBeNull();
  });

  it("uses the same pattern in both (PowerShell ends with backslash z where bash ends with $)", () => {
    expect(powershellPattern.endsWith("\\z")).toBe(true);
    expect(powershellPattern.slice(0, -2) + "$").toBe(bashPattern);
  });

  itBash(
    "refuses a hyphenated id in the entrypoint, and the other ids the scripts refuse",
    () => {
      const refused = ["a-b", "-x", "", "a b", "..", "a/b", "ok\nx", "_a"];
      const accepted = ["0", "7", "smoke", "a_b", "S0c"];
      const verdicts = entrypointVerdicts([...refused, ...accepted]);
      refused.forEach((id, i) => expect(verdicts[i], JSON.stringify(id)).toBe("refused"));
      accepted.forEach((id, i) => expect(verdicts[refused.length + i], id).toBe("accepted"));
    },
    30_000,
  );
});
