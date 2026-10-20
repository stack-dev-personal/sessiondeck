import { execFileSync } from "node:child_process";
import { chmod, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveHostName } from "../host.ts";
import { ensurePrivateDir, writeFileAtomic } from "../install/atomic.ts";

/** probe.json: hub URL, token, host name. Lives in the probe home, never in settings.json. */
export interface ProbeConfig {
  hubUrl?: string;
  token?: string;
  host: string;
}

export class ConfigError extends Error {}

export async function readConfig(path: string): Promise<ProbeConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON; fix or delete it`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path} is not a JSON object`);
  }
  const r = raw as Record<string, unknown>;
  const cfg: ProbeConfig = {
    host: typeof r["host"] === "string" && r["host"] ? r["host"] : resolveHostName(),
  };
  if (typeof r["hubUrl"] === "string") cfg.hubUrl = r["hubUrl"];
  if (typeof r["token"] === "string") cfg.token = r["token"];
  return cfg;
}

/** Host names end up in hook and statusline command lines: keep them to plain characters. */
export function validateHostName(name: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new ConfigError("--host-name may contain only letters, digits, '.', '_' and '-'");
  }
  return name;
}

export function validateHubUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError("--hub is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ConfigError("--hub must be an http or https URL");
  }
  return url;
}

export function validateToken(token: string): string {
  const t = token.trim();
  if (!t) throw new ConfigError("the token is empty");
  if (/\s/.test(t)) throw new ConfigError("the token contains whitespace");
  return t;
}

/** The current user's SID (S-1-5-...) from `whoami /user`, so the grant does not depend on names. */
export function currentUserSid(): string {
  const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  if (!m?.[1]) throw new Error("no SID in whoami output");
  return m[1];
}

/** Windows: drop inherited ACEs and grant only the current user, by SID. Throws on failure. */
export function restrictWindowsAcl(path: string): void {
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `*${currentUserSid()}:F`], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    throw new ConfigError(
      `could not restrict permissions on ${path} with icacls; nothing was written (the token stays out of the file)`,
    );
  }
}

/**
 * Makes sure an existing probe.json is user-only (POSIX 0600, Windows user-only ACL). Used on
 * reruns that do not rewrite the file.
 */
export async function ensureConfigPrivate(path: string): Promise<void> {
  if (process.platform === "win32") {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      restrictWindowsAcl(path);
    return;
  }
  const s = await stat(path).catch(() => undefined);
  if (s && (s.mode & 0o777) !== 0o600) await chmod(path, 0o600);
}

/**
 * Writes probe.json with user-only permissions. POSIX: file 0o600 (set and verified on the open
 * descriptor before any data is written), directory 0o700. Windows: ACL restricted to the current
 * user by SID before the token is written; if that fails the temp file is removed, nothing is
 * written and a ConfigError is thrown.
 */
export async function writeConfig(path: string, cfg: ProbeConfig): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const body: Record<string, unknown> = {};
  if (cfg.hubUrl !== undefined) body["hubUrl"] = cfg.hubUrl;
  if (cfg.token !== undefined) body["token"] = cfg.token;
  body["host"] = cfg.host;
  await writeFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
    beforeWrite: async (tmp) => {
      if (process.platform === "win32") restrictWindowsAcl(tmp);
    },
  });
}

/** Config for display: the token is never shown. */
export function maskedConfig(cfg: ProbeConfig): Record<string, unknown> {
  return { ...cfg, token: cfg.token ? "********" : null };
}
