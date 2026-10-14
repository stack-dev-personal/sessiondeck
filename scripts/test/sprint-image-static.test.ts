import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const override = read("test", "docker-compose.test.yml");
const harness = read("test", "check-sprint-image.sh");

describe("sprint entrypoint", () => {
  it("starts with the bash shebang and contains no CR bytes", () => {
    expect(entrypoint.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(entrypoint).not.toContain("\r");
  });

  it("is checked out with LF line endings", () => {
    const result = spawnSync("git", ["check-attr", "eol", "infra/sprint/entrypoint.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/: eol: lf$/);
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
    const exportAt = entrypoint.indexOf("export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0");
    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(entrypoint.indexOf('claude -p "$('));
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
    expect(entrypoint).toContain('log "failed at line $2 with status $1"');
  });

  it("forwards SIGTERM and SIGINT to claude and keeps its exit status", () => {
    expect(entrypoint).toMatch(/trap forward_signal TERM INT/);
    expect(entrypoint).toMatch(/forward_signal\(\) \{[^}]*kill -TERM "\$claude_pid"/s);
    expect(entrypoint).toMatch(/wait "\$claude_pid" \|\| rc=\$\?/);
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

// Names set by ENV instructions, including continuation lines.
function envNamesFrom(text: string): string[] {
  const names: string[] = [];
  let inEnv = false;
  for (const line of text.split("\n")) {
    if (/^ENV\s/.test(line)) inEnv = true;
    if (inEnv) {
      for (const match of line.matchAll(/(?:^ENV\s+|^\s+)([A-Za-z_][A-Za-z0-9_]*)=/g)) {
        names.push(match[1] ?? "");
      }
      inEnv = line.trimEnd().endsWith("\\");
    }
  }
  return names;
}

describe("sprint entrypoint environment allow-list", () => {
  const block =
    /# BEGIN env-allow-list\n([\s\S]*?)# END env-allow-list/.exec(entrypoint)?.[1] ?? "";
  const allowedNames = /ALLOWED_ENV_NAMES=\(([\s\S]*?)\n\)/.exec(block)?.[1]?.split(/\s+/) ?? [];

  function run(names: string[]): { status: number | null; stderr: string } {
    const quoted = names.map((entry) => `'${entry}'`).join(" ");
    const script = `readonly EXIT_CONFIG=64\n${block}\nprintf '%s\\0' ${quoted} | refuse_unlisted_environment\n`;
    const result = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  }

  it("runs before the privilege drop and before anything is exported", () => {
    const checkAt = entrypoint.indexOf("refuse_unlisted_environment </proc/self/environ");
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(entrypoint.indexOf("setpriv"));
    expect(checkAt).toBeLessThan(entrypoint.indexOf("export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"));
  });

  it("allows the tokens, SPRINT_*, and every name the Dockerfile sets with ENV", () => {
    const dockerfileNames = envNamesFrom(dockerfile);
    expect(dockerfileNames.length).toBeGreaterThan(3);
    for (const name of [...dockerfileNames, ...TOKEN_NAMES]) {
      expect(allowedNames).toContain(name);
    }
  });

  it("does not allow anything that could redirect the token or run code", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "BASH_ENV",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
    ]) {
      expect(allowedNames).not.toContain(name);
    }
    expect(allowedNames.some((name) => name.startsWith("GIT_CONFIG"))).toBe(false);
  });

  it("accepts a clean environment", () => {
    const result = run([
      "PATH=/usr/bin",
      "CLAUDE_CODE_OAUTH_TOKEN=x",
      "GH_TOKEN=y",
      "SPRINT_ID=0",
      "_=/usr/bin/setpriv",
      "HOME=/home/sprint",
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("refuses unlisted variables with exit 64, naming them and never their values", () => {
    const result = run([
      "PATH=/usr/bin",
      "ANTHROPIC_BASE_URL=https://secret-value-host.invalid",
      "BASH_FUNC_id%%=() { :; }",
      "LD_PRELOAD=/secret-value.so",
    ]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("ANTHROPIC_BASE_URL");
    expect(result.stderr).toContain("LD_PRELOAD");
    expect(result.stderr).toContain("BASH_FUNC_id%%");
    expect(result.stderr).not.toContain("secret-value");
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

  it("copies only the entrypoint and ignores everything else", () => {
    const copies = dockerfile.split("\n").filter((line) => /^\s*COPY\b/.test(line));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain("entrypoint.sh");
    const ignore = read(".dockerignore").split("\n");
    expect(ignore).toContain("*");
    expect(ignore).toContain("!entrypoint.sh");
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

  it("gives the test container no environment the entrypoint allow-list would refuse", () => {
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

  it("requires an authentication message for the non-root real binary", () => {
    expect(harness).toContain("AUTH_PATTERN");
    expect(harness).toMatch(/-ne 126.*-ne 127/s);
  });

  it("clears per-run artifacts and proves the output filter and the allow-list", () => {
    expect(harness).toContain('"$state_dir/logs/sprint.jsonl"');
    expect(harness).toContain("expect_marker");
    expect(harness).toContain("ANTHROPIC_BASE_URL not on the allow-list");
  });
});
