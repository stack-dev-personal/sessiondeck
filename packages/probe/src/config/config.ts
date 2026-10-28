import { execFileSync } from "node:child_process";
import { chmod, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { resolveHostName } from "../host.ts";
import { isFile, system32Dir } from "../win-utf8.ts";
import { ensurePrivateDir, writeFileAtomic } from "../install/atomic.ts";

/** probe.json: hub URL, token, host name. Lives in the probe home, never in settings.json. */
export interface ProbeConfig {
  hubUrl?: string;
  token?: string;
  host: string;
  /** Opt-in to cleartext http for a non-loopback hub (a LAN hub without TLS). */
  allowInsecureHub?: boolean;
  /** Vault archive import (Phase 5): read-only roots scanned by the daemon. */
  archive?: ArchiveConfig;
}

export interface ArchiveConfig {
  roots: Array<{ label: string; path: string }>;
  /** Seconds between scans; default 300, minimum 30. */
  intervalSec?: number;
}

export const ARCHIVE_DEFAULT_INTERVAL_SEC = 300;
export const ARCHIVE_MIN_INTERVAL_SEC = 30;
const ARCHIVE_MAX_ROOTS = 16;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates the `archive` block of probe.json. Throws ConfigError with a clear message. */
export function validateArchiveConfig(raw: unknown): ArchiveConfig {
  if (!isPlainObject(raw)) throw new ConfigError("probe.json: archive must be an object");
  for (const k of Object.keys(raw)) {
    if (k !== "roots" && k !== "intervalSec") {
      throw new ConfigError(`probe.json: unknown key archive.${k}`);
    }
  }
  const rootsRaw = raw["roots"];
  if (!Array.isArray(rootsRaw)) throw new ConfigError("probe.json: archive.roots must be an array");
  if (rootsRaw.length > ARCHIVE_MAX_ROOTS) {
    throw new ConfigError(`probe.json: archive.roots has more than ${ARCHIVE_MAX_ROOTS} entries`);
  }
  const seen = new Set<string>();
  const roots: ArchiveConfig["roots"] = [];
  rootsRaw.forEach((r: unknown, i: number) => {
    const at = `archive.roots[${i}]`;
    if (!isPlainObject(r)) throw new ConfigError(`probe.json: ${at} must be an object`);
    for (const k of Object.keys(r)) {
      if (k !== "label" && k !== "path")
        throw new ConfigError(`probe.json: unknown key ${at}.${k}`);
    }
    const label = r["label"];
    if (typeof label !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(label)) {
      throw new ConfigError(
        `probe.json: ${at}.label must be 1-64 letters, digits, '_' or '-', starting with a letter or digit`,
      );
    }
    const path = r["path"];
    if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
      throw new ConfigError(`probe.json: ${at}.path must be an absolute path`);
    }
    if (seen.has(label.toLowerCase())) {
      throw new ConfigError(`probe.json: duplicate archive root label "${label}"`);
    }
    seen.add(label.toLowerCase());
    roots.push({ label, path });
  });
  const out: ArchiveConfig = { roots };
  const iv = raw["intervalSec"];
  if (iv !== undefined) {
    if (typeof iv !== "number" || !Number.isFinite(iv) || iv < ARCHIVE_MIN_INTERVAL_SEC) {
      throw new ConfigError(
        `probe.json: archive.intervalSec must be a number of at least ${ARCHIVE_MIN_INTERVAL_SEC}`,
      );
    }
    out.intervalSec = iv;
  }
  return out;
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
  if (r["allowInsecureHub"] === true) cfg.allowInsecureHub = true;
  if (r["archive"] !== undefined) cfg.archive = validateArchiveConfig(r["archive"]);
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
  if (u.username !== "" || u.password !== "") {
    throw new ConfigError("--hub must not contain a user name or password");
  }
  return url;
}

export function validateToken(token: string): string {
  const t = token.trim();
  if (!t) throw new ConfigError("the token is empty");
  if (/\s/.test(t)) throw new ConfigError("the token contains whitespace");
  return t;
}

export interface SysDeps {
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  /** Runs an absolute executable with cwd System32 and a timeout; returns stdout. */
  run: (file: string, args: string[], opts: { cwd: string; timeout: number }) => string;
}

const defaultDeps: SysDeps = {
  env: process.env,
  exists: isFile,
  run: (file, args, opts) =>
    execFileSync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      env: { SystemRoot: opts.cwd.slice(0, -"\\System32".length) },
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
};

/** `<SystemRoot>\System32\<name>` (never a PATH or cwd lookup); throws when it is not a file. */
export function resolveSystemExe(
  name: string,
  d: Pick<SysDeps, "env" | "exists"> = defaultDeps,
): { exe: string; dir: string } {
  const dir = system32Dir(d.env);
  const exe = `${dir}\\${name}`;
  if (!d.exists(exe)) throw new Error(`${exe} not found`);
  return { exe, dir };
}

/**
 * A real per-user SID: local or domain accounts (S-1-5-21-...) and Entra ID accounts (S-1-12-1-...).
 * Well-known group SIDs (Everyone, Authenticated Users, BUILTIN groups) are refused.
 */
export function validateUserSid(sid: string): string {
  if (
    !/^S-1-(?:5-21|12-1)-\d+(?:-\d+)+$/.test(sid) ||
    sid === "S-1-1-0" ||
    sid === "S-1-5-11" ||
    sid.startsWith("S-1-5-32-")
  ) {
    throw new Error("whoami did not return a user SID");
  }
  return sid;
}

/** The current user's SID from `whoami /user`, so the grant does not depend on names. */
export function currentUserSid(d: SysDeps = defaultDeps): string {
  const { exe, dir } = resolveSystemExe("whoami.exe", d);
  const out = d.run(exe, ["/user", "/fo", "csv", "/nh"], { cwd: dir, timeout: 10000 });
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  if (!m?.[1]) throw new Error("no SID in whoami output");
  return validateUserSid(m[1]);
}

const EXTRA_PRINCIPALS = ["*S-1-5-18", "*S-1-5-32-544", "*S-1-3-4"];

/** Windows: drop inherited ACEs and grant only the current user, by SID. Throws on failure. */
export function restrictWindowsAcl(path: string, d: SysDeps = defaultDeps): void {
  try {
    const sid = currentUserSid(d);
    const { exe, dir } = resolveSystemExe("icacls.exe", d);
    d.run(exe, [path, "/inheritance:r", "/grant:r", `*${sid}:F`], { cwd: dir, timeout: 10000 });
    // The creating process's default DACL can add explicit ACEs that /inheritance:r keeps
    // (SYSTEM, Administrators, Owner Rights). Remove every principal but the user.
    d.run(exe, [path, "/remove:g", ...EXTRA_PRINCIPALS], { cwd: dir, timeout: 10000 });
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
  if (cfg.allowInsecureHub === true) body["allowInsecureHub"] = true;
  if (cfg.archive !== undefined) body["archive"] = cfg.archive;
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
