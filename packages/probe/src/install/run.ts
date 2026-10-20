import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ConfigError,
  ensureConfigPrivate,
  maskedConfig,
  readConfig,
  validateHostName,
  validateHubUrl,
  validateToken,
  writeConfig,
} from "../config/config.ts";
import {
  type PathEnv,
  claudeSettingsPath,
  installStatePath,
  probeConfigPath,
  probeHome,
} from "../cli-paths.ts";
import { resolveHostName } from "../host.ts";
import { ensurePrivateDir } from "./atomic.ts";
import { HOOK_EVENTS, MARKER } from "./events.ts";
import {
  type Ctx,
  SettingsShapeError,
  isRecord,
  type StatusKey,
  STATUS_KEYS,
  applyInstall,
  applyUninstall,
  validateSettings,
} from "./merge.ts";
import {
  SettingsReadError,
  commitSettings,
  loadSettings,
  removeBackups,
  serialize,
} from "./settings-io.ts";
import { getEntry, putEntry } from "./state.ts";
import { isDeepStrictEqual } from "node:util";

export interface RunIo {
  pathEnv: PathEnv;
  /** Directory holding hook.mjs, statusline.mjs, subagents.mjs (dist/). */
  distDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  readStdin: () => Promise<string>;
}

const HELP = `probe: sessiondeck laptop probe

usage:
  probe install [--hub <url>] [--token-file <path> | --token-stdin] [--host-name <name>]
                [--settings <path>] [--statusline=replace] [--home <dir>] [--allow-inside-claude]
  probe uninstall [--purge] [--settings <path>] [--home <dir>]
  probe config show [--home <dir>]
  probe --help

The token is never accepted as an argument (argv is visible to other processes).
Settings default to $CLAUDE_CONFIG_DIR/settings.json, else the default Claude Code user directory.
`;

interface Args {
  command: string;
  sub?: string;
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = [
  "--hub",
  "--token-file",
  "--host-name",
  "--settings",
  "--statusline",
  "--home",
];
const BOOL_FLAGS = ["--token-stdin", "--purge", "--allow-inside-claude", "--help", "-h"];

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--token" || a.startsWith("--token=")) {
      throw new UsageError(
        "the token is not accepted as an argument (argv is visible to other processes); use --token-file <path> or --token-stdin",
      );
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.includes(name)) {
      const value = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      flags.set(name, value);
    } else if (BOOL_FLAGS.includes(a)) {
      flags.set(a, true);
    } else if (a.startsWith("-")) {
      throw new UsageError(`unknown option ${name}`);
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? "", sub: positional[1], flags };
}

function str(flags: Args["flags"], name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

const toSlash = (p: string): string => p.replace(/\\/g, "/");

/**
 * The statusLine command runs through whichever shell Claude Code uses (Git Bash, PowerShell,
 * cmd), so every word is limited to characters that mean the same in all of them. Anything else
 * (curly quotes, %, $, `, ',', '@', non-ASCII) is refused rather than quoted.
 */
const SHELL_SAFE = /^[A-Za-z0-9 _./:=+-]+$/;

function shellWord(word: string): string {
  if (!SHELL_SAFE.test(word)) {
    throw new SettingsShapeError(
      `cannot install: the path ${JSON.stringify(word)} has characters that are unsafe in a statusLine command (allowed: letters, digits, space and _ . / : = + -). Install from or into a path without them.`,
    );
  }
  return word.includes(" ") ? `"${word}"` : word;
}

/** Nearest ancestor (or self) of dir that contains a `.git`, if any. */
function gitWorkTreeAbove(dir: string): string | undefined {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

function shellCommand(script: string, home: string, host: string): string {
  return ["node", script, "--home", home, "--host", host, MARKER].map(shellWord).join(" ");
}

export function buildCtx(distDir: string, homeDir: string, host: string): Ctx {
  const dir = toSlash(resolve(distDir));
  const home = toSlash(resolve(homeDir));
  return {
    hookPath: `${dir}/hook.mjs`,
    home,
    host,
    statuslineCommand: shellCommand(`${dir}/statusline.mjs`, home, host),
    subagentsCommand: shellCommand(`${dir}/subagents.mjs`, home, host),
  };
}

async function resolveToken(args: Args, io: RunIo): Promise<string | undefined> {
  const file = str(args.flags, "--token-file");
  const stdin = args.flags.has("--token-stdin");
  if (file && stdin) throw new UsageError("use either --token-file or --token-stdin, not both");
  if (file) {
    try {
      return validateToken(await readFile(file, "utf8"));
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`cannot read the token file ${file}`);
    }
  }
  if (stdin) return validateToken(await io.readStdin());
  return undefined;
}

async function install(args: Args, io: RunIo): Promise<number> {
  const replaceStatus = ((): boolean => {
    const v = str(args.flags, "--statusline");
    if (v === undefined) return false;
    if (v !== "replace") throw new UsageError('--statusline only accepts "replace"');
    return true;
  })();
  const e = io.pathEnv;
  const homeFlag = str(args.flags, "--home");
  const home = probeHome(e, homeFlag);
  if (e.env["CLAUDECODE"] && !args.flags.has("--allow-inside-claude")) {
    throw new UsageError(
      "refusing to install from inside a Claude Code session (CLAUDECODE is set); run it in your own terminal, or pass --allow-inside-claude",
    );
  }
  if (!homeFlag) {
    const repo = gitWorkTreeAbove(home);
    if (repo) {
      throw new UsageError(
        `refusing to use ${home} as the probe home: it is inside the git work tree ${repo} (the token and spool would be committable). Pass --home <dir> to choose it explicitly`,
      );
    }
  }
  io.out(`probe home: ${home}`);
  const settingsPath = str(args.flags, "--settings") ?? claudeSettingsPath(e);
  const hubFlag = str(args.flags, "--hub");
  const hubUrl = hubFlag === undefined ? undefined : validateHubUrl(hubFlag);
  const token = await resolveToken(args, io);

  // Config values, read-only until the settings are known good. Keep what exists unless given.
  const cfgPath = probeConfigPath(e, homeFlag);
  const existing = await readConfig(cfgPath);
  const hostFlag = str(args.flags, "--host-name");
  const cfg = {
    hubUrl: hubUrl ?? existing?.hubUrl,
    token: token ?? existing?.token,
    host:
      (hostFlag === undefined ? undefined : validateHostName(hostFlag)) ??
      existing?.host ??
      resolveHostName(),
  };
  const ctx = buildCtx(io.distDir, home, validateHostName(cfg.host));

  // Settings first, read-only: a malformed file aborts before anything is written.
  const loaded = await loadSettings(settingsPath);
  validateSettings(loaded.settings);
  const stateFile = installStatePath(e, homeFlag);
  const prior = await getEntry(stateFile, loaded.path);
  const result = applyInstall(loaded.settings, ctx, prior, loaded.existed, { replaceStatus });

  const sameCfg =
    existing !== undefined &&
    existing.hubUrl === cfg.hubUrl &&
    existing.token === cfg.token &&
    existing.host === cfg.host;
  if (!sameCfg) await writeConfig(cfgPath, cfg);
  else {
    await ensurePrivateDir(home);
    await ensureConfigPrivate(cfgPath);
  }

  const changed = serialize(result.settings, loaded.layout) !== loaded.original || !loaded.existed;
  let backup: string | undefined;
  if (changed) {
    backup = await commitSettings(loaded, result.settings, home);
    if (backup) io.out(`backed up the previous settings to ${backup}`);
  }
  // Remember which backup holds each value we replaced: uninstall verifies against it.
  const backups: Partial<Record<StatusKey, string>> = {};
  for (const key of STATUS_KEYS) {
    const kept = prior?.backups?.[key];
    const fresh = result.entry.previous[key].present && !prior?.previous[key].present;
    const b = fresh ? backup : kept;
    if (b) backups[key] = b;
  }
  await putEntry(stateFile, loaded.path, { ...result.entry, backups });
  io.out(
    `${changed ? "installed into" : "already installed in"} ${loaded.path} (${HOOK_EVENTS.length} hook events)`,
  );
  for (const n of result.notices) io.out(`notice: ${n}`);
  io.out(`config: ${cfgPath}`);
  if (!cfg.hubUrl || !cfg.token) {
    io.out("note: hub URL or token not set yet; events are spooled locally until they are");
  }
  return 0;
}

/** Keys whose recorded previous value equals the one in the backup taken at install. */
async function verifyPrevious(
  entry: ReturnType<typeof getEntry> extends Promise<infer T> ? T : never,
  io: RunIo,
): Promise<Set<StatusKey>> {
  const ok = new Set<StatusKey>();
  if (!entry) return ok;
  for (const key of STATUS_KEYS) {
    const prev = entry.previous[key];
    if (!prev.present) continue;
    const file = entry.backups?.[key];
    let matches = false;
    if (file) {
      try {
        const doc: unknown = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
        matches = isRecord(doc) && isDeepStrictEqual(doc[key], prev.value);
      } catch {
        matches = false;
      }
    }
    if (matches) {
      ok.add(key);
      io.out(`restoring your previous ${key}: ${JSON.stringify(prev.value)}`);
    } else {
      io.err(
        `warning: the recorded previous ${key} does not match the install backup${file ? ` ${file}` : " (no backup recorded)"}; not restoring it (${key} removed)`,
      );
    }
  }
  return ok;
}

async function uninstall(args: Args, io: RunIo): Promise<number> {
  const e = io.pathEnv;
  const homeFlag = str(args.flags, "--home");
  const home = probeHome(e, homeFlag);
  io.out(`probe home: ${home}`);
  const settingsPath = str(args.flags, "--settings") ?? claudeSettingsPath(e);
  const loaded = await loadSettings(settingsPath);
  validateSettings(loaded.settings);
  const stateFile = installStatePath(e, homeFlag);
  const entry = await getEntry(stateFile, loaded.path);
  if (loaded.existed) {
    const verified = await verifyPrevious(entry, io);
    const next = applyUninstall(loaded.settings, entry, verified);
    if (serialize(next, loaded.layout) === loaded.original) {
      io.out(`nothing to remove in ${loaded.path}`);
    } else {
      const removeFile = entry?.createdFile === true && Object.keys(next).length === 0;
      const backup = await commitSettings(loaded, removeFile ? undefined : next, home);
      if (backup) io.out(`backed up the previous settings to ${backup}`);
      io.out(`removed the probe entries from ${loaded.path}`);
    }
  } else {
    io.out(`no settings file at ${loaded.path}; nothing to remove`);
  }
  await putEntry(stateFile, loaded.path, undefined);
  if (args.flags.has("--purge")) {
    await rm(probeConfigPath(e, homeFlag), { force: true });
    const n = await removeBackups(home);
    io.out(`removed probe.json and ${n} settings backup${n === 1 ? "" : "s"}`);
  } else {
    io.out(
      `left ${probeConfigPath(e, homeFlag)} and the settings backups in place (use --purge to delete them)`,
    );
  }
  return 0;
}

async function configShow(args: Args, io: RunIo): Promise<number> {
  const cfgPath = probeConfigPath(io.pathEnv, str(args.flags, "--home"));
  const cfg = await readConfig(cfgPath);
  if (!cfg) {
    io.err(`no config at ${cfgPath}; run probe install`);
    return 1;
  }
  io.out(`# ${cfgPath}`);
  io.out(JSON.stringify(maskedConfig(cfg), null, 2));
  return 0;
}

export async function run(argv: string[], io: RunIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.flags.has("--help") || args.flags.has("-h") || args.command === "") {
      io.out(HELP);
      return args.command === "" && !args.flags.has("--help") && !args.flags.has("-h") ? 2 : 0;
    }
    if (args.command === "install") return await install(args, io);
    if (args.command === "uninstall") return await uninstall(args, io);
    if (args.command === "config" && args.sub === "show") return await configShow(args, io);
    throw new UsageError(`unknown command ${args.command}${args.sub ? ` ${args.sub}` : ""}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`probe: ${e.message}\n${HELP}`);
      return 2;
    }
    if (
      e instanceof SettingsReadError ||
      e instanceof SettingsShapeError ||
      e instanceof ConfigError
    ) {
      io.err(`probe: ${e.message}`);
      return 1;
    }
    const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "UNKNOWN";
    io.err(`probe: failed (${code}): ${e instanceof Error ? e.message : "unknown error"}`);
    return 1;
  }
}

export async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
