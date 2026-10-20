import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  ConfigError,
  maskedConfig,
  readConfig,
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
} from "../paths.ts";
import { ensurePrivateDir } from "./atomic.ts";
import { HOOK_EVENTS, MARKER } from "./events.ts";
import {
  type Ctx,
  SettingsShapeError,
  applyInstall,
  applyUninstall,
  validateSettings,
} from "./merge.ts";
import { SettingsReadError, commitSettings, loadSettings, serialize } from "./settings-io.ts";
import { getEntry, putEntry } from "./state.ts";

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
  probe install [--hub <url>] [--token-file <path> | --token-stdin] [--host <name>]
                [--settings <path>] [--statusline=replace]
  probe uninstall [--purge] [--settings <path>]
  probe config show
  probe --help

The token is never accepted as an argument (argv is visible to other processes).
Settings default to $CLAUDE_CONFIG_DIR/settings.json, else the default Claude Code user directory.
`;

interface Args {
  command: string;
  sub?: string;
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = ["--hub", "--token-file", "--host", "--settings", "--statusline"];
const BOOL_FLAGS = ["--token-stdin", "--purge", "--help", "-h"];

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

/** Characters that would break out of a double-quoted Git Bash string. */
const SHELL_UNSAFE = /["$`\\!\n\r]/;

function shellCommand(script: string): string {
  if (SHELL_UNSAFE.test(script)) {
    throw new SettingsShapeError(`path contains characters unsafe for a shell command: ${script}`);
  }
  const quoted = /\s/.test(script) ? `"${script}"` : script;
  return `node ${quoted} ${MARKER}`;
}

export function buildCtx(distDir: string): Ctx {
  const dir = toSlash(resolve(distDir));
  return {
    hookPath: `${dir}/hook.mjs`,
    statuslineCommand: shellCommand(`${dir}/statusline.mjs`),
    subagentsCommand: shellCommand(`${dir}/subagents.mjs`),
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
  const home = probeHome(e);
  const settingsPath = str(args.flags, "--settings") ?? claudeSettingsPath(e);
  const ctx = buildCtx(io.distDir);
  const hubFlag = str(args.flags, "--hub");
  const hubUrl = hubFlag === undefined ? undefined : validateHubUrl(hubFlag);
  const token = await resolveToken(args, io);

  // Settings first, read-only: a malformed file aborts before anything is written.
  const loaded = await loadSettings(settingsPath);
  validateSettings(loaded.settings);
  const stateFile = installStatePath(e);
  const prior = await getEntry(stateFile, loaded.path);
  const result = applyInstall(loaded.settings, ctx, prior, loaded.existed, { replaceStatus });

  // Config: keep what exists unless a new value is given.
  const cfgPath = probeConfigPath(e);
  const existing = await readConfig(cfgPath);
  const cfg = {
    hubUrl: hubUrl ?? existing?.hubUrl,
    token: token ?? existing?.token,
    host: str(args.flags, "--host") ?? existing?.host ?? hostname(),
  };
  const sameCfg =
    existing !== undefined &&
    existing.hubUrl === cfg.hubUrl &&
    existing.token === cfg.token &&
    existing.host === cfg.host;
  if (!sameCfg) for (const w of await writeConfig(cfgPath, cfg)) io.err(`warning: ${w}`);
  else await ensurePrivateDir(home);

  const changed = serialize(result.settings, loaded.layout) !== loaded.original || !loaded.existed;
  if (changed) {
    const backup = await commitSettings(loaded, result.settings, home);
    if (backup) io.out(`backed up the previous settings to ${backup}`);
  }
  await putEntry(stateFile, loaded.path, result.entry);
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

async function uninstall(args: Args, io: RunIo): Promise<number> {
  const e = io.pathEnv;
  const home = probeHome(e);
  const settingsPath = str(args.flags, "--settings") ?? claudeSettingsPath(e);
  const loaded = await loadSettings(settingsPath);
  validateSettings(loaded.settings);
  const stateFile = installStatePath(e);
  const entry = await getEntry(stateFile, loaded.path);
  if (loaded.existed) {
    const next = applyUninstall(loaded.settings, entry);
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
    await rm(probeConfigPath(e), { force: true });
    io.out("removed probe.json");
  } else {
    io.out(`left ${probeConfigPath(e)} in place (use --purge to delete it)`);
  }
  return 0;
}

async function configShow(io: RunIo): Promise<number> {
  const cfgPath = probeConfigPath(io.pathEnv);
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
    if (args.command === "config" && args.sub === "show") return await configShow(io);
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
