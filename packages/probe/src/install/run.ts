import { existsSync } from "node:fs";
import { checkHubUrl } from "../daemon/hub-url.ts";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
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
import { type ExePlan, ExeError, installExe, planExe, pruneExeDir } from "./exe.ts";
import { exeHomeRefusal } from "./home-check.ts";
import {
  type Ctx,
  type Runtime,
  SettingsShapeError,
  isRecord,
  type StatusKey,
  STATUS_KEYS,
  hasProbeEntries,
  installedHome,
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
import { realSlash } from "./real-path.ts";
import { getEntry, isInHome, otherExeDirs, putEntry } from "./state.ts";
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
                [--runtime exe|node] [--exe-dir <dir>]
  probe uninstall [--purge] [--settings <path>] [--home <dir>]
  probe config show [--home <dir>]
  probe daemon run | install | uninstall [--home <dir>]
  probe --help

--runtime exe (default) copies the built exes to <home>/bin/<hash>/ and registers them; build them
with: pnpm -F @sessiondeck/probe build:exe
--runtime node registers node + dist/*.mjs instead.
--exe-dir <dir> takes the exes from <dir> instead of dist/exe/<platform>.
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
  "--runtime",
  "--exe-dir",
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

/**
 * The statusLine command runs through whichever shell Claude Code uses (Git Bash, PowerShell,
 * cmd), so every word is limited to characters that mean the same in all of them. Anything else
 * (curly quotes, %, $, `, ',', '@', non-ASCII) is refused rather than quoted.
 *
 * `~` is allowed in the middle of a word only. Shells expand it at the START of a word (home
 * directory); an absolute path starts with a drive letter or `/`, and `~` after that (Windows 8.3
 * short names such as C:/Users/RUNNER~1, a folder called a~b) is literal in Git Bash, PowerShell and
 * cmd. A word that starts with `~` is refused. Paths are also expanded with realpath.native first,
 * which turns 8.3 short names into long names.
 */
const SHELL_SAFE = /^[A-Za-z0-9 _./:=+~-]+$/;

export function isShellSafe(word: string): boolean {
  return SHELL_SAFE.test(word) && !word.startsWith("~");
}

function shellWord(word: string): string | undefined {
  if (!isShellSafe(word)) return undefined;
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

function shellCommand(program: string[], home: string, host: string): string | undefined {
  const words = [...program, "--home", home, "--host", host, MARKER].map(shellWord);
  return words.every((w) => w !== undefined) ? words.join(" ") : undefined;
}

export function buildCtx(distDir: string, homeDir: string, host: string, exe?: ExePlan): Ctx {
  const dir = realSlash(distDir);
  const home = realSlash(homeDir);
  const ctx: Ctx = { hookPath: `${dir}/hook.mjs`, home, host };
  // The statusLine command runs in Git Bash or PowerShell, and a quoted first word works in only one
  // of them. So an exe path that needs quoting (a space) gets the Node form for the two status
  // commands (`node "<dist script>"`, what --runtime node writes); the hooks, which are argv, keep
  // the exe form.
  const exeInShell = exe !== undefined && !Object.values(exe.paths).some((p) => p.includes(" "));
  const statusProgram = (name: "statusline" | "subagents"): string[] =>
    exe !== undefined && exeInShell ? [exe.paths[name]] : ["node", `${dir}/${name}.mjs`];
  const statusline = shellCommand(statusProgram("statusline"), home, host);
  const subagents = shellCommand(statusProgram("subagents"), home, host);
  if (exe) {
    ctx.hookExe = exe.paths.hook;
    ctx.exeDir = realSlash(exe.dir);
    if (!exeInShell) ctx.statusRuntime = "node";
  }
  if (statusline !== undefined) ctx.statuslineCommand = statusline;
  if (subagents !== undefined) ctx.subagentsCommand = subagents;
  if (statusline === undefined || subagents === undefined) {
    // Hooks are argv and never reach a shell; only the shell-run status commands need safe paths.
    const program = exe !== undefined && exeInShell ? realSlash(exe.dir) : dir;
    const bad = [program, home].filter((p) => !isShellSafe(p));
    ctx.statusSkipReason = `the path ${bad.map((p) => JSON.stringify(p)).join(", ") || JSON.stringify(program)} has characters that are unsafe in a statusLine command (allowed: letters, digits, space and _ . / : = + ~ -, no ~ at the start); hooks were installed, statusLine and subagentStatusLine were skipped. Install from or into a path without them to enable them`;
  }
  return ctx;
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

function refuseInsideClaude(args: Args, e: PathEnv, verb: string): void {
  if (e.env["CLAUDECODE"] && !args.flags.has("--allow-inside-claude")) {
    throw new UsageError(
      `refusing to ${verb} from inside a Claude Code session (CLAUDECODE is set); run it in your own terminal, or pass --allow-inside-claude`,
    );
  }
}

function runtimeOf(args: Args): Runtime {
  const v = str(args.flags, "--runtime") ?? "exe";
  if (v !== "exe" && v !== "node")
    throw new UsageError(`--runtime accepts "exe" or "node", got ${v}`);
  return v;
}

async function install(args: Args, io: RunIo): Promise<number> {
  const runtime = runtimeOf(args);
  const replaceStatus = ((): boolean => {
    const v = str(args.flags, "--statusline");
    if (v === undefined) return false;
    if (v !== "replace") throw new UsageError('--statusline only accepts "replace"');
    return true;
  })();
  const e = io.pathEnv;
  const homeFlag = str(args.flags, "--home");
  const home = probeHome(e, homeFlag);
  refuseInsideClaude(args, e, "install");
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
    ...(existing?.allowInsecureHub === true ? { allowInsecureHub: true } : {}),
    ...(existing?.archive !== undefined ? { archive: existing.archive } : {}),
  };
  // Exe form: Claude Code runs this binary on every hook, so the home must not be swappable by
  // another account (same rule as `daemon install`); then hash the sources (read-only).
  if (runtime === "exe") {
    const refusal = await exeHomeRefusal(e, home);
    if (refusal) {
      throw new ExeError(
        `refusing the exe form in ${home}: ${refusal}. Use the default home, or --runtime node`,
      );
    }
  }
  const exePlan =
    runtime === "exe" ? await planExe(io.distDir, home, str(args.flags, "--exe-dir")) : undefined;
  const ctx = buildCtx(io.distDir, home, validateHostName(cfg.host), exePlan);
  if (ctx.statusRuntime === "node") {
    io.out(
      "notice: the exe path contains a space, so statusLine and subagentStatusLine use the Node form (node + dist script); hooks use the exe",
    );
  }

  // Settings first, read-only: a malformed file aborts before anything is written.
  const loaded = await loadSettings(settingsPath);
  validateSettings(loaded.settings);
  const stateFile = installStatePath(e, homeFlag);
  const prior = await getEntry(stateFile, loaded.path);
  const result = applyInstall(loaded.settings, ctx, prior, loaded.existed, { replaceStatus });
  if (exePlan) {
    await installExe(exePlan, home);
    io.out(`exes: ${exePlan.dir}`);
  }

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
  // The settings now point away from the previous exe directory; remove it (ours, recorded only).
  if (prior?.exeDir && prior.exeDir !== result.entry.exeDir) {
    const note = await pruneExeDir(prior.exeDir, home, await otherExeDirs(stateFile, loaded.path));
    if (note) io.out(`notice: ${note}`);
  }
  io.out(
    `${changed ? "installed into" : "already installed in"} ${loaded.path} (${HOOK_EVENTS.length} hook events)`,
  );
  for (const n of result.notices) io.out(`notice: ${n}`);
  io.out(`config: ${cfgPath}`);
  if (!cfg.hubUrl || !cfg.token) {
    io.out("note: hub URL or token not set yet; events are spooled locally until they are");
  }
  io.out(
    "next: `probe daemon install` starts the forwarder at every logon (or `probe daemon run` for this terminal); install does not register it for you",
  );
  if (cfg.hubUrl && checkHubUrl(cfg.hubUrl, cfg.allowInsecureHub === true).ok === false) {
    io.out(
      "note: the daemon will not send to this hub URL: use https, or http to loopback, or set allowInsecureHub to true in probe.json for a LAN hub without TLS",
    );
  }
  return 0;
}

/** Keys whose recorded previous value equals the one in the backup taken at install. */
async function verifyPrevious(
  entry: ReturnType<typeof getEntry> extends Promise<infer T> ? T : never,
  io: RunIo,
  home: string,
): Promise<Set<StatusKey>> {
  const ok = new Set<StatusKey>();
  if (!entry) return ok;
  for (const key of STATUS_KEYS) {
    const prev = entry.previous[key];
    if (!prev.present) continue;
    const file = entry.backups?.[key];
    let matches = false;
    if (file && !prev.invalid && isInHome(file, home)) {
      try {
        if (!(await lstat(file)).isFile()) throw new Error("not a regular file");
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
  refuseInsideClaude(args, e, "uninstall");
  const settingsPath = str(args.flags, "--settings") ?? claudeSettingsPath(e);
  const loaded = await loadSettings(settingsPath);
  validateSettings(loaded.settings);
  // Without --home, use the one our installed hook entries carry (a later plain uninstall must
  // find the state, backups and token of the install that wrote them).
  let homeFlag = str(args.flags, "--home");
  let inferred = false;
  if (!homeFlag) {
    const recorded = installedHome(loaded.settings);
    if (recorded && (isAbsolute(recorded) || win32.isAbsolute(recorded))) {
      homeFlag = recorded;
      inferred = true;
    } else if (recorded) {
      io.err(
        `warning: ignoring the relative --home ${JSON.stringify(recorded)} in the installed hook`,
      );
    }
  }
  const home = probeHome(e, homeFlag);
  io.out(`probe home: ${home}${inferred ? " (from the installed hook entries)" : ""}`);
  const stateFile = installStatePath(e, homeFlag);
  const entry = await getEntry(stateFile, loaded.path);
  if (inferred && !entry) {
    // The inferred home comes from a hook entry anyone could have written. Without an install
    // record there it is only trusted when it is the default home or outside any git work tree
    // (backups of settings.json, which may hold env secrets, are copied into the home).
    const repo = gitWorkTreeAbove(home);
    if (repo && home !== probeHome(e)) {
      throw new UsageError(
        `refusing to use ${home} (from the installed hook entries) as the probe home: it is inside the git work tree ${repo} and has no install record for ${loaded.path}. Pass --home <dir> to choose it explicitly`,
      );
    }
  }
  if (!entry && hasProbeEntries(loaded.settings)) {
    io.err(
      `warning: probe entries are installed in ${loaded.path} but no install record was found in ${stateFile}; any statusLine you replaced is not restored. Pass --home <dir> if the install used another home`,
    );
  }
  if (loaded.existed) {
    const verified = await verifyPrevious(entry, io, home);
    const next = applyUninstall(loaded.settings, entry, verified);
    if (serialize(next, loaded.layout) === loaded.original) {
      io.out(`nothing to remove in ${loaded.path}`);
    } else {
      const removeFile = entry?.createdFile === true && Object.keys(next).length === 0;
      // A home inferred from a hook entry with no install record there is not trusted with a
      // copy of settings.json: the backup goes to the CLI default home.
      const backupHome = inferred && !entry ? probeHome(e) : home;
      const backup = await commitSettings(loaded, removeFile ? undefined : next, backupHome);
      if (backup) io.out(`backed up the previous settings to ${backup}`);
      io.out(`removed the probe entries from ${loaded.path}`);
    }
  } else {
    io.out(`no settings file at ${loaded.path}; nothing to remove`);
  }
  if (entry?.exeDir) {
    // A home taken from the hook entries (settings data) that is not the CLI default is not trusted
    // with a recursive delete.
    const note =
      inferred && home !== probeHome(e)
        ? `not removing ${entry.exeDir}: the home ${home} was inferred from the installed hook entries; pass --home <dir> to remove it`
        : await pruneExeDir(entry.exeDir, home, await otherExeDirs(stateFile, loaded.path));
    if (note) io.out(`notice: ${note}`);
  }
  if (entry || !inferred) await putEntry(stateFile, loaded.path, undefined);
  if (args.flags.has("--purge") && inferred && !entry) {
    io.err(
      `warning: not purging ${home}: it was inferred from the installed hook entries and holds no install record for ${loaded.path}. Pass --home <dir> with --purge to delete its probe.json and backups`,
    );
    io.out(`left ${probeConfigPath(e, homeFlag)} and the settings backups in place`);
  } else if (args.flags.has("--purge")) {
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
  refuseInsideClaude(args, io.pathEnv, "show the config");
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
      e instanceof ExeError ||
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
