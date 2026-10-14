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
    expect(entrypoint).toMatch(/^set -euo pipefail$/m);
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
});
