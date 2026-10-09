// @ts-expect-error TS5097: explicit .ts specifiers let Node run this file without a build step
import { StateFileError } from "./state-file-error.ts";

// A tripwire, not a scanner: it catches the credential shapes this project's containers and
// sessions actually handle, so a careless status write fails loudly. It does not replace
// keeping secrets out of the status files in the first place.

/** Prefixes of well-known credentials. Matched at a word start so "highs_" does not trip "ghs_". */
export const SECRET_VALUE_PREFIXES = [
  "sk-ant-", // Anthropic API keys and OAuth tokens
  "ghp_", // GitHub personal access token (classic)
  "gho_", // GitHub OAuth access token
  "ghu_", // GitHub user-to-server token
  "ghs_", // GitHub server-to-server token
  "ghr_", // GitHub refresh token
  "github_pat_", // GitHub fine-grained personal access token
] as const;

/** Environment variable names that hold credentials; as a JSON key they mean a secret is stored. */
export const SECRET_KEY_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN", // container token for Claude Code
  "GH_TOKEN", // container token for gh
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Deep enough for any status file; also stops a cyclic value from overflowing the stack. */
export const SECRET_SCAN_MAX_DEPTH = 32;

// The prefixes contain only letters, digits, "-" and "_", so they need no regex escaping.
const PREFIX_PATTERN = new RegExp(`(?<![A-Za-z0-9])(?:${SECRET_VALUE_PREFIXES.join("|")})`);
const KEY_NAMES_UPPER: readonly string[] = SECRET_KEY_NAMES.map((n) => n.toUpperCase());

const KEY_PLACEHOLDER = "<key>";

function hasSecretShape(text: string): boolean {
  return PREFIX_PATTERN.test(text);
}

function isSecretKey(key: string): boolean {
  return hasSecretShape(key) || KEY_NAMES_UPPER.includes(key.toUpperCase());
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function scan(value: unknown, path: string, depth: number): string | undefined {
  if (depth > SECRET_SCAN_MAX_DEPTH) return `${path} (nested too deeply to scan)`;
  if (typeof value === "string") return hasSecretShape(value) ? path : undefined;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = scan(item, `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      // A key that is itself a credential must not be echoed back in the path.
      if (isSecretKey(key)) return childPath(path, hasSecretShape(key) ? KEY_PLACEHOLDER : key);
      const hit = scan(item, childPath(path, key), depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** JSON path of the first suspicious entry, or undefined. Never returns the value itself. */
export function findSecretPath(value: unknown): string | undefined {
  return scan(value, "$", 0);
}

/** Throws a StateFileError naming the JSON path (never the value) if the value looks secret. */
export function assertNoSecrets(value: unknown): void {
  const path = findSecretPath(value);
  if (path !== undefined) {
    throw new StateFileError("secret", `refusing to write a credential-looking entry at ${path}`);
  }
}
